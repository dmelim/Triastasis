use serde::Serialize;
use std::process::Command;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareInfo {
    backend: String,
    gpu_index: i32,
    gpu_name: Option<String>,
    vram_mb: Option<u64>,
}

fn parse_nvidia_smi_line(line: &str) -> Option<(String, u64)> {
    let (name, memory) = line.trim().rsplit_once(',')?;
    let vram_mb = memory.trim().parse().ok()?;
    Some((name.trim().to_string(), vram_mb))
}

#[tauri::command]
pub fn detect_hardware_info() -> HardwareInfo {
    let cfg = crate::config::load();
    let backend = cfg
        .as_ref()
        .map(|value| value.backend.clone())
        .unwrap_or_else(|| "unknown".to_string());
    let gpu_index = cfg.as_ref().map(|value| value.gpu).unwrap_or(0);

    if gpu_index < 0 {
        return HardwareInfo {
            backend,
            gpu_index,
            gpu_name: None,
            vram_mb: None,
        };
    }

    let mut command = Command::new("nvidia-smi");
    command.args([
        "--query-gpu=name,memory.total",
        "--format=csv,noheader,nounits",
        "--id",
        &gpu_index.to_string(),
    ]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let detected = command
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .and_then(|stdout| stdout.lines().next().and_then(parse_nvidia_smi_line));
    let (gpu_name, vram_mb) = detected
        .map(|(name, memory)| (Some(name), Some(memory)))
        .unwrap_or((None, None));

    HardwareInfo {
        backend,
        gpu_index,
        gpu_name,
        vram_mb,
    }
}

#[cfg(test)]
mod tests {
    use super::parse_nvidia_smi_line;

    #[test]
    fn parses_nvidia_smi_name_and_memory() {
        assert_eq!(
            parse_nvidia_smi_line("NVIDIA GeForce RTX 4070, 12282"),
            Some(("NVIDIA GeForce RTX 4070".to_string(), 12282))
        );
    }

    #[test]
    fn rejects_incomplete_nvidia_smi_output() {
        assert_eq!(parse_nvidia_smi_line("NVIDIA GeForce RTX 4070"), None);
    }
}
