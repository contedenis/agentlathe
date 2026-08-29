import { z } from "zod";

const base = {
  name: z.string().min(1),
  description: z.string().min(1),
  content: z.string().min(1),
  isActive: z.boolean().optional(),
};

export const skillCreateSchema = z.object(base);
export const skillUpdateSchema = z.object(base).partial();
