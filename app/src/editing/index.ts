export {
  analyzeConnectedComponents,
  analyzeComponents,
  type ComponentAnalysis,
  type ComponentAnalysisOptions,
  type ConnectedComponent,
  type PositionWeldMode,
  runDuplicatedSeamConnectivityFixture,
  type SeamConnectivityFixtureResult,
} from "./components";
export {
  cloneGeometry,
  removeConnectedComponents,
  removeComponents,
  recalculateNormals,
  repairNormals,
  reverseTriangleWinding,
  type GeometryOperationResult,
  type RemoveComponentsOptions,
  type WindingOptions,
} from "./geometry";
export {
  disposeGeometrySnapshot,
  EditHistory,
  type EditCommand,
  type EditHistoryOptions,
} from "./history";
