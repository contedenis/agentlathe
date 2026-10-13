import {
  CRITERION_DESCRIPTION_MAX_LENGTH,
  DEFAULT_CRITERION_FAIL_BELOW,
  DEFAULT_CRITERION_PASS_ABOVE,
} from "@agentlathe/db/constants";
import { z } from "zod";
import { isUuid } from "@/lib/api-helpers";

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((value) => (value === "" ? null : value));

const threshold = z.number().min(0).max(1);

const fields = {
  question: z.string().trim().min(1).max(1000),
  passDescription: optionalText(CRITERION_DESCRIPTION_MAX_LENGTH),
  failDescription: optionalText(CRITERION_DESCRIPTION_MAX_LENGTH),
  appliesWhen: optionalText(1000),
  failBelow: threshold.optional(),
  passAbove: threshold.optional(),
};

export function thresholdsInOrder(value: {
  failBelow?: number;
  passAbove?: number;
}): boolean {
  return (
    (value.failBelow ?? DEFAULT_CRITERION_FAIL_BELOW) <=
    (value.passAbove ?? DEFAULT_CRITERION_PASS_ABOVE)
  );
}

const thresholdOrderIssue = {
  message: "failBelow must not be greater than passAbove",
  path: ["failBelow"],
};

export const criterionDraftSchema = z
  .object(fields)
  .refine(thresholdsInOrder, thresholdOrderIssue);

export const criterionCreateSchema = z
  .object({
    ...fields,
    isActive: z.boolean().optional(),
    sourceFixDraftId: z
      .string()
      .refine(isUuid, { message: "must be a valid uuid" })
      .nullable()
      .optional(),
  })
  .refine(thresholdsInOrder, thresholdOrderIssue);

export const criterionUpdateSchema = z
  .object({ ...fields, isActive: z.boolean().optional() })
  .partial()
  .refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: "at least one field is required",
  });

export const thresholdOrderError = thresholdOrderIssue.message;
