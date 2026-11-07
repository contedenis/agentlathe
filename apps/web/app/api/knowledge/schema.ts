import { z } from "zod";

const name = z.string().trim().min(1).max(200);
const description = z.string().trim().max(2000);

export const collectionCreateSchema = z.object({
  name,
  description: description.default(""),
});
export const collectionUpdateSchema = z.object({ name, description }).partial();
