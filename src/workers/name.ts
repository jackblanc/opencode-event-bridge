const maxWorkerNameLength = 63;

export const makeStageWorkerName = (stage: string, suffix: string) => {
  const normalizedStage =
    stage
      .toLowerCase()
      .replaceAll(/[^a-z0-9-]/g, "-")
      .replaceAll(/-+/g, "-")
      .replace(/^-|-$/g, "") || "stage";
  const prefix = `oeb-${suffix}-`;

  return `${prefix}${normalizedStage}`.slice(0, maxWorkerNameLength).replace(/-$/g, "");
};
