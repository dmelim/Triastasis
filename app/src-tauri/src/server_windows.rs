use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::process::Child;
use windows_sys::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};

/// Created before spawning; only our new, suspended child is assigned.
/// The OS closes this handle on an app crash, terminating all assigned processes.
pub fn create_job() -> Result<OwnedHandle, String> {
    unsafe {
        let raw = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if raw.is_null() {
            return Err(format!(
                "could not create server lifetime job: {}",
                std::io::Error::last_os_error()
            ));
        }
        let job = OwnedHandle::from_raw_handle(raw as _);
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            raw,
            JobObjectExtendedLimitInformation,
            &limits as *const _ as _,
            std::mem::size_of_val(&limits) as u32,
        ) == 0
        {
            return Err(format!(
                "could not configure server lifetime job: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(job)
    }
}

pub fn assign_and_resume(job: &OwnedHandle, child: &Child) -> Result<(), String> {
    unsafe {
        if AssignProcessToJobObject(
            job.as_raw_handle() as HANDLE,
            child.as_raw_handle() as HANDLE,
        ) == 0
        {
            return Err(format!(
                "could not bind server lifetime to the app: {}",
                std::io::Error::last_os_error()
            ));
        }
        // std::process::Child owns the process handle, but does not expose the
        // primary thread. Find that suspended thread using the documented API.
        let raw = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if raw == INVALID_HANDLE_VALUE {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let snapshot = OwnedHandle::from_raw_handle(raw as _);
        let mut entry: THREADENTRY32 = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
        let mut found = Thread32First(snapshot.as_raw_handle() as _, &mut entry);
        while found != 0 {
            if entry.th32OwnerProcessID == child.id() {
                let raw_thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                if raw_thread.is_null() {
                    return Err(std::io::Error::last_os_error().to_string());
                }
                let thread = OwnedHandle::from_raw_handle(raw_thread as _);
                if ResumeThread(thread.as_raw_handle() as _) == u32::MAX {
                    return Err(std::io::Error::last_os_error().to_string());
                }
                return Ok(());
            }
            found = Thread32Next(snapshot.as_raw_handle() as _, &mut entry);
        }
        Err("could not find the suspended server thread; server was not started".into())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    use std::time::{Duration, Instant};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
    };

    fn sleeper(suspended: bool) -> Child {
        Command::new("powershell.exe")
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 30",
            ])
            .creation_flags(0x08000000 | if suspended { 4 } else { 0 })
            .spawn()
            .unwrap()
    }
    #[test]
    fn closing_job_kills_only_owned_child() {
        let job = create_job().unwrap();
        let mut owned = sleeper(true);
        let mut external = sleeper(false);
        let result = assign_and_resume(&job, &owned);
        if result.is_err() {
            let _ = owned.kill();
            let _ = external.kill();
        }
        result.unwrap();
        drop(job);
        let deadline = Instant::now() + Duration::from_secs(3);
        while owned.try_wait().unwrap().is_none() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        let killed = owned.try_wait().unwrap().is_some();
        let external_alive = external.try_wait().unwrap().is_none();
        let _ = owned.kill();
        let _ = owned.wait();
        let _ = external.kill();
        let _ = external.wait();
        assert!(killed, "job closure must terminate the owned child");
        assert!(external_alive, "independent processes must survive");
    }
    #[test]
    fn job_owner_helper() {
        let Ok(marker) = std::env::var("TRIASTASIS_JOB_TEST_MARKER") else {
            return;
        };
        let job = create_job().unwrap();
        let mut owned = sleeper(true);
        if let Err(error) = assign_and_resume(&job, &owned) {
            let _ = owned.kill();
            panic!("{error}");
        }
        std::fs::write(marker, owned.id().to_string()).unwrap();
        std::thread::sleep(Duration::from_secs(20));
        drop(job);
    }
    #[test]
    fn abrupt_owner_exit_terminates_owned_server_fixture() {
        let marker =
            std::env::temp_dir().join(format!("triastasis-job-crash-{}.txt", std::process::id()));
        let _ = std::fs::remove_file(&marker);
        let mut owner = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "server::windows_lifetime::tests::job_owner_helper",
                "--nocapture",
            ])
            .env("TRIASTASIS_JOB_TEST_MARKER", &marker)
            .creation_flags(0x08000000)
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !marker.is_file() && Instant::now() < deadline && owner.try_wait().unwrap().is_none()
        {
            std::thread::sleep(Duration::from_millis(20));
        }
        if !marker.is_file() {
            let _ = owner.kill();
            let _ = owner.wait();
            panic!("synthetic owner did not create the child marker");
        }
        let pid: u32 = std::fs::read_to_string(&marker).unwrap().parse().unwrap();
        unsafe {
            let raw = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
            assert!(!raw.is_null(), "fixture child should be alive");
            let process = OwnedHandle::from_raw_handle(raw as _);
            owner.kill().unwrap();
            owner.wait().unwrap();
            assert_eq!(
                WaitForSingleObject(process.as_raw_handle() as _, 3000),
                0,
                "OS must terminate the child when its owner's handles close on crash"
            );
        }
        let _ = std::fs::remove_file(marker);
    }
}
