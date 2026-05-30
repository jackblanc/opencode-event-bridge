import type { LinearAgentActivitySignalMetadata } from "../client/client.ts";

import { pathBasename } from "../../opencode/client.ts";

export type OpenCodeProject = {
  readonly directory: string;
  readonly id: string;
  readonly name: string;
};

export const repoLabelPrefix = "repo:";
const repoLabelGroup = "repo";

export const normalize = (value: string) => value.trim().toLowerCase();

export const projectCandidatesFromLabels = (
  labels: ReadonlyArray<{
    readonly name: string;
    readonly parent: { readonly name: string } | null;
  }>,
) =>
  labels
    .map((label) => {
      if (label.name.startsWith(repoLabelPrefix)) {
        return label.name.slice(repoLabelPrefix.length).trim();
      }

      if (label.parent?.name === repoLabelGroup) {
        return label.name.trim();
      }

      return label.name.trim();
    })
    .filter((label) => label.length > 0);

export const matchProject = (input: {
  readonly candidates: ReadonlyArray<string>;
  readonly projects: ReadonlyArray<OpenCodeProject>;
}) => {
  const candidates = new Set(input.candidates.map(normalize));
  const matches = input.projects.filter(
    (project) =>
      candidates.has(normalize(project.name)) ||
      candidates.has(normalize(pathBasename(project.directory))),
  );

  return matches.length === 1 ? matches[0] : undefined;
};

export const selectMetadata = (
  options: ReadonlyArray<string>,
): LinearAgentActivitySignalMetadata => ({
  options: options.map((option) => ({ label: option, value: option })),
});
