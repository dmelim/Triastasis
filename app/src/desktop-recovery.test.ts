import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { transform } from "esbuild";
import { DEFAULT_PARAMS, normalizeGenParams } from "./types";
import { safeStem, manifestRecordedParams } from "./generation-manifest";

const source = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/main.ts"), "utf8");
function productionFunction(name: string): string {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf("\n}", start) + 2);
}
async function harness(names: string[], fixture: Record<string, unknown>, extra: string) {
  const code = (await transform(names.map(productionFunction).join("\n").replace('await import("@tauri-apps/plugin-fs")', "testFs") + "\n" + extra, {loader:"ts", target:"es2022"})).code;
  return new Function(...Object.keys(fixture), code)(...Object.values(fixture));
}
const noop = () => {};
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => resolve = r); return {promise, resolve}; }

test("a later selection wins even if the earlier image decode finishes last", async () => {
  const a = new Blob(["A"]), b = new Blob(["B"]);
  const da = deferred<boolean>(), db = deferred<boolean>();
  const api = await harness(["setInput"], {
    inputSelectionSequence: 0, appliedInputSelection: 0, inputImage: null, inputName: "", imageDecodes: (blob: Blob) => blob === a ? da.promise : db.promise,
    toast: noop, setInputPreviewBlob: noop, inputPreview: {classList:{remove:noop}}, dropHint: {classList:{add:noop}},
    clearMaskPreview: noop, showInputPreview: noop, updateGenerateEnabled: noop,
  }, "return {setInput, get:()=>inputImage, invalidate:()=>++inputSelectionSequence};");
  const first = api.setInput(a, "A.png"), second = api.setInput(b, "B.png");
  db.resolve(true); await second; da.resolve(true); await first;
  assert.equal(api.get(), b);
  const staleNativeSelection = api.invalidate();
  await api.setInput(a, "A.png");
  await api.setInput(b, "old-native-drop.png", staleNativeSelection);
  assert.equal(api.get(), a, "native reads carry their original selection token");
});

test("sweep input remains the same as its manifests while preparation awaits disk", async () => {
  const a = new Blob(["A"]), b = new Blob(["B"]), preparation = deferred<unknown[]>();
  const jobs: Array<{image: Blob; name: string}> = [];
  let prepared: {sourceBlob: Blob} | undefined;
  const api = await harness(["doSweep"], {
    inputImage:a,inputName:"A.png",generationBackendReady:()=>true,readParams:()=>DEFAULT_PARAMS,normalizeGenParams,
    clearParamErrors:noop,showParamError:noop,SWEEP_MIN_CANDIDATES:2,SWEEP_MAX_CANDIDATES:8,$:()=>({value:"3"}),
    createSweepSeeds:()=>[1,2,3],toast:noop,hardwareRestriction:()=>null,newId:()=>"sweep",isTauri:()=>true,safeStem,
    prepareSweepManifests:(input: {sourceBlob:Blob})=>{prepared=input;return preparation.promise;},candidates:[],sweepCandidates:new Map(),
    candidateWrap:{classList:{remove:noop}},renderCandidates:noop,activeId:null,currentGlb:null,currentJob:null,generationQueue:[],
    queueJob:(job: {image:Blob;name:string})=>jobs.push(job),showQueueConfirmation:noop,
  }, "return {doSweep, select:(blob,name)=>{inputImage=blob;inputName=name;}};");
  const pending = api.doSweep(); api.select(b,"B.png"); preparation.resolve([{}, {}, {}]); await pending;
  assert.equal(prepared?.sourceBlob,a); assert.equal(jobs.length,3);
  assert.ok(jobs.every(job=>job.image===a && job.name==="A.png"));
});

function generationFixture(overrides: Record<string, unknown> = {}) {
  return {
    normalizeGenParams,newRequestId:()=>"request",newId:()=>"record",safeStem,startGenerationManifest:async()=>({dir:"C:/original",fileName:"original.triastasis.json"}),
    requiresTerminalFinalization:()=>true,finishGenerationManifest:async()=>{},finishResumedManifest:async()=>{},startProgressPolling:()=>noop,
    generate:async()=>({glb:new Blob(["glb"])}),inspectGeneratedGlb:async()=>({dimensions:null,warning:null}),isTauri:()=>true,
    saveToOutputDir:async()=>null,putGeneratedVersion:async()=>({persisted:true}),revealAssetDock:noop,refreshGallery:async()=>{},
    hasDurableGeneratedArtifact:(_:boolean,path:string|null)=>Boolean(path),metricsFromModelMetrics:(v:unknown)=>v,
    noteManifestWriteFailure:noop,warnedEphemeral:false,toast:noop,...overrides,
  };
}
test("resumed generations keep original asset/sweep identity and save beside their manifest", async () => {
  const saves: unknown[][] = [], finishes: Array<{status:string;modelName:string}> = [];
  const api = await harness(["generateRecord"], generationFixture({
    saveToOutputDir:async(...args:unknown[])=>{saves.push(args);return `${args[2]}/${args[0]}`;},
    finishResumedManifest:async(_path:string,patch:{status:string;modelName:string})=>finishes.push(patch),
  }), "return generateRecord;");
  const rec = await api(DEFAULT_PARAMS,new Blob(["A"]),"A.png",new AbortController().signal,false,false,
    {id:"sweep",index:2,count:4},{path:"C:/old-package/a.triastasis.json",assetId:"sweep",versionId:"candidate"});
  assert.equal(rec.assetId,"sweep");assert.equal(rec.sweepIndex,2);assert.equal(rec.versionId,"candidate");
  assert.equal(saves[0][2],"C:/old-package");assert.equal(finishes[0].status,"completed");assert.equal(finishes[0].modelName,saves[0][0]);
});
test("new generation saves stay in their initial package and a failed write never completes it", async () => {
  const patches: Array<{status:string}> = [];
  const api = await harness(["generateRecord"], generationFixture({
    saveToOutputDir:async(_name:string,_bytes:unknown,dir:string)=>{assert.equal(dir,"C:/original");throw new Error("synthetic full disk");},
    finishGenerationManifest:async(_context:unknown,patch:{status:string})=>patches.push(patch),
  }), "return generateRecord;");
  await api(DEFAULT_PARAMS,new Blob(["A"]),"A.png",new AbortController().signal,false,false);
  assert.deepEqual(patches.map(patch=>patch.status),["failed"]);
});

test("clearing recovered queued work persists cancellation before refreshing recovery", async () => {
  const start=source.indexOf('clearQueueBtn.addEventListener("click", async () => {');
  const handler=source.slice(start,source.indexOf('\n});',start)+4);
  const events:string[]=[]; let click!:()=>Promise<void>;
  const code=(await transform(handler,{loader:"ts"})).code;
  new Function("clearQueueBtn","generationQueue","finishResumedManifest","cancelCandidateManifest","newRequestId","renderCandidates","announceSweepWhenComplete","updateQueueStatus","checkInterruptedManifests","toast","noteManifestWriteFailure",code)(
    {addEventListener:(_:string,fn:()=>Promise<void>)=>click=fn},
    [{resumeManifest:{path:"C:/package/a.triastasis.json",versionId:"a",assetId:"group"},sweep:{id:"group"},candidate:{status:"queued"}}],
    async(_path:string,patch:{status:string})=>{events.push(patch.status);},async()=>{},()=>"cancel-request",noop,noop,noop,async()=>{events.push("scan");},noop,noop);
  await click();assert.deepEqual(events,["cancelled","scan"]);
});


test("individual manifest recovery carries original sweep membership to the queued job", async () => {
  const jobs: any[] = [];
  const api = await harness(["requeueFromManifest"], {
    readManifestAsset:async()=>[1,2],safeStem,isRecoveryEntryActive:()=>false,queueJob:(job:unknown)=>jobs.push(job),
    normalizeGenParams,manifestRecordedParams,toast:noop,manifestStoresAdvancedSettings:()=>true,
  }, "return requeueFromManifest;");
  await api("C:/synthetic/job.triastasis.json", {assetId:"group",versionId:"candidate",label:"Candidate",seed:0,resolution:512,
    bgRemoval:"auto",uv:"xatlas",texture:true,sweep:{groupId:"group",index:2,count:4,state:"queued"}});
  assert.deepEqual(jobs[0].sweep,{id:"group",index:2,count:4});
  assert.equal(jobs[0].resumeManifest.assetId,"group");
});

test("the viewed source remains attached to the model when generation input changes", async () => {
  const image={src:"",removeAttribute(){this.src="";}};
  const control={classList:{toggle:noop,add:noop},setAttribute:noop};
  const a=new Blob(["A"]), b=new Blob(["B"]);
  const api = await harness(["setModelReference","syncViewerReference","setInputPreviewBlob"], {
    modelReferenceUrl:null,inputObjectUrl:null,workspaceMode:"view",currentGlb:{},viewerReferenceImage:image,
    viewerReferenceToggle:control,viewerReferencePopover:control,inputPreview:{src:""},
  }, "return {setModelReference,setInputPreviewBlob};");
  api.setModelReference(a);const original=image.src;
  api.setInputPreviewBlob(b);assert.equal(image.src,original);
  api.setModelReference(null);assert.equal(image.src,"");
});

test("standalone GLB adoption clears its source and refreshes the loaded mesh inspector", async () => {
  const calls:string[]=[];
  const instance={load:async()=>({triangles:3})};
  const api=await harness(["viewGlbFileNow"],{
    testFs:{readFile:async()=>new Uint8Array([1,2,3])},getViewer:async()=>instance,disposeEditorSession:noop,
    setWorkspaceMode:noop,activeParams:{},activeLabel:"old",currentGlb:{},activeId:"old",
    setModelReference:(value:unknown)=>{assert.equal(value,null);calls.push("source-cleared");},
    renderMeshParts:(value:unknown)=>{assert.equal(value,instance);calls.push("mesh-refreshed");},
    renderViewerStats:noop,setViewerTools:noop,viewerCaption:{textContent:""},standaloneView:null,updateStandaloneActions:noop,
    toast:(message:string)=>{throw new Error(message);},
  },"return viewGlbFileNow;");
  await api("C:/synthetic/multipart.glb");assert.deepEqual(calls,["source-cleared","mesh-refreshed"]);
});


async function clipboardHarness(read: () => Promise<unknown[]>, imageDecodes: (blob: Blob) => Promise<boolean> = async () => true) {
  return harness(["setInput", "pasteInput"], {
    navigator: { clipboard: { read } }, inputSelectionSequence: 0, appliedInputSelection: 0, inputImage: null, inputName: "",
    imageDecodes, toast: noop, setInputPreviewBlob: noop,
    inputPreview: { classList: { remove: noop } }, dropHint: { classList: { add: noop } },
    clearMaskPreview: noop, showInputPreview: noop, updateGenerateEnabled: noop,
  }, "return {setInput, pasteInput, get:()=>inputImage};");
}

for (const delayedStage of ["read", "getType"]) {
  test(`paste cannot replace a newer selection after delayed clipboard ${delayedStage}`, async () => {
    const a = new Blob(["clipboard A"]), b = new Blob(["selected B"]);
    const read = deferred<unknown[]>(), image = deferred<Blob>(), getTypeStarted = deferred<void>();
    const item = { types: ["image/png"], getType: () => { getTypeStarted.resolve(); return image.promise; } };
    const api = await clipboardHarness(() => read.promise);
    const paste = api.pasteInput({ clipboardData: { items: [] } });
    if (delayedStage === "getType") { read.resolve([item]); await getTypeStarted.promise; }
    await api.setInput(b, "B.png");
    read.resolve([item]); image.resolve(a); await paste;
    assert.equal(api.get(), b);
  });
}

test("failed clipboard reads and failed image retrieval retain the current image", async () => {
  const image = new Blob(["current"]);
  for (const read of [
    async () => { throw new Error("clipboard permission denied"); },
    async () => [{ types: ["image/png"], getType: async () => { throw new Error("clipboard changed"); } }],
  ]) {
    const api = await clipboardHarness(read);
    await api.setInput(image, "current.png");
    await api.pasteInput({ clipboardData: { items: [] } });
    assert.equal(api.get(), image);
    const next = new Blob(["new selection"]); await api.setInput(next, "next.png");
    assert.equal(api.get(), next);
  }
});


for (const failure of ["text-only", "read-failed", "getType-failed", "decode-failed"]) {
  test(`a ${failure} paste cannot discard a pending valid image decode`, async () => {
    const previous = new Blob(["previous A"]), selected = new Blob(["selected B"]), invalid = new Blob(["invalid clipboard"]);
    const decode = deferred<boolean>();
    const read = async () => {
      if (failure === "read-failed") throw new Error("permission denied");
      if (failure === "text-only") return [{ types: ["text/plain"] }];
      return [{ types: ["image/png"], getType: async () => {
        if (failure === "getType-failed") throw new Error("clipboard changed");
        return invalid;
      } }];
    };
    const api = await clipboardHarness(read, blob => blob === selected ? decode.promise : Promise.resolve(blob !== invalid));
    await api.setInput(previous, "A.png");
    const pending = api.setInput(selected, "B.png");
    await api.pasteInput({ clipboardData: { items: [{ type: "text/plain" }] } });
    assert.equal(api.get(), previous);
    decode.resolve(true); await pending;
    assert.equal(api.get(), selected);
  });
}

test("pending clipboard images use initiation order despite a newer empty paste and reversed read completion", async () => {
  const older = new Blob(["older image"]), newer = new Blob(["newer image"]);
  const reads = [deferred<unknown[]>(), deferred<unknown[]>(), deferred<unknown[]>()];
  let index = 0;
  const api = await clipboardHarness(() => reads[index++].promise);
  const first = api.pasteInput({ clipboardData: { items: [] } });
  const second = api.pasteInput({ clipboardData: { items: [] } });
  const empty = api.pasteInput({ clipboardData: { items: [{ type: "text/plain" }] } });
  reads[2].resolve([{ types: ["text/plain"] }]); await empty;
  reads[1].resolve([{ types: ["image/png"], getType: async () => newer }]); await second;
  reads[0].resolve([{ types: ["image/png"], getType: async () => older }]); await first;
  assert.equal(api.get(), newer);
});

test("a failed newer clipboard image read leaves an earlier pending clipboard image eligible", async () => {
  const image = new Blob(["valid earlier clipboard image"]);
  const firstRead = deferred<unknown[]>();
  let count = 0;
  const api = await clipboardHarness(() => ++count === 1 ? firstRead.promise : Promise.reject(new Error("permission denied")));
  const first = api.pasteInput({ clipboardData: { items: [] } });
  await api.pasteInput({ clipboardData: { items: [] } });
  firstRead.resolve([{ types: ["image/png"], getType: async () => image }]); await first;
  assert.equal(api.get(), image);
});

test("explicit model/input clearing still invalidates older pending image decodes", async () => {
  const decode = deferred<boolean>(), image = new Blob(["old pending image"]);
  const api = await harness(["setInput", "clearCurrentModelState"], {
    inputSelectionSequence: 0, appliedInputSelection: 0, inputImage: null, inputName: "",
    imageDecodes: () => decode.promise, toast: noop, setInputPreviewBlob: noop,
    inputPreview: { classList: { remove: noop } }, dropHint: { classList: { add: noop } },
    clearMaskPreview: noop, showInputPreview: noop, updateGenerateEnabled: noop,
    setModelReference: noop, disposeEditorSession: noop, activeId: null, currentGlb: null,
    activeParams: null, activeLabel: "", clearStandaloneView: noop, clearInputPreview: noop,
    renderViewerStats: noop, setViewerTools: noop,
  }, "return {setInput, clearCurrentModelState, get:()=>inputImage};");
  const pending = api.setInput(image, "pending.png");
  api.clearCurrentModelState(); decode.resolve(true); await pending;
  assert.equal(api.get(), null);
});
