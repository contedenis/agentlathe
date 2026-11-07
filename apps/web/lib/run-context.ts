import { RUN_LABEL_MAX_LENGTH } from "@agentlathe/db/constants";

export type LabelHeader =
  | { ok: true; value: string | null }
  | { ok: false; error: string };

export function readLabelHeader(headers: Headers, name: string): LabelHeader {
  const value = headers.get(name)?.trim();
  if (!value) return { ok: true, value: null };
  if (value.length > RUN_LABEL_MAX_LENGTH)
    return {
      ok: false,
      error: `${name} must be at most ${RUN_LABEL_MAX_LENGTH} characters.`,
    };
  return { ok: true, value };
}
