const maxWorkerNameLength = 63;

export const makeStageWorkerName = (input: { readonly stage: string; readonly suffix: string }) => {
  const normalizedStage =
    input.stage
      .toLowerCase()
      .replaceAll(/[^a-z0-9-]/g, "-")
      .replaceAll(/-+/g, "-")
      .replace(/^-|-$/g, "") || "stage";
  const prefix = `oeb-${input.suffix}-`;

  return `${prefix}${normalizedStage}`.slice(0, maxWorkerNameLength).replace(/-$/g, "");
};
