import {
  db,
  knowledgeDocuments,
  knowledgeFiles,
  MAX_DOCUMENT_BYTES,
} from "@agentlathe/db";
import { isUuid } from "@/lib/api-helpers";
import { scheduleKnowledgeProcessing } from "@/lib/knowledge/engine";
import { detectMediaType } from "@/lib/knowledge/extract";

const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const FILENAME_MAX_LENGTH = 255;
const TOO_LARGE = `Files can be at most ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB.`;

const badRequest = (error: string, status = 400) =>
  Response.json({ error }, { status });

function shorten(name: string): string {
  const chars = [...name];
  if (chars.length <= FILENAME_MAX_LENGTH) return name;
  const dot = name.lastIndexOf(".");
  const extension = [...name.slice(dot)];
  return [
    ...chars.slice(0, FILENAME_MAX_LENGTH - extension.length),
    ...extension,
  ].join("");
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id)) return badRequest("Invalid id.");
  if (
    Number(req.headers.get("content-length") ?? 0) >
    MAX_DOCUMENT_BYTES + MULTIPART_OVERHEAD_BYTES
  )
    return badRequest(TOO_LARGE, 413);

  let file: FormDataEntryValue | null;
  try {
    file = (await req.formData()).get("file");
  } catch {
    return badRequest("Send the file as multipart/form-data in a file field.");
  }
  if (!(file instanceof File))
    return badRequest("Send the file as multipart/form-data in a file field.");
  if (file.size === 0) return badRequest("The file is empty.");
  if (file.size > MAX_DOCUMENT_BYTES) return badRequest(TOO_LARGE, 413);

  const basename = (file.name.split(/[\\/]/).pop() ?? "").trim();
  const bytes = Buffer.from(await file.arrayBuffer());
  const detected = detectMediaType(basename, bytes);
  if ("error" in detected) return badRequest(detected.error, 415);
  const filename = shorten(basename);

  const document = await db
    .transaction(async (tx) => {
      const [row] = await tx
        .insert(knowledgeDocuments)
        .values({
          collectionId: id,
          filename,
          mediaType: detected.mediaType,
          size: bytes.length,
        })
        .returning({
          id: knowledgeDocuments.id,
          filename: knowledgeDocuments.filename,
          mediaType: knowledgeDocuments.mediaType,
          size: knowledgeDocuments.size,
          status: knowledgeDocuments.status,
        });
      await tx.insert(knowledgeFiles).values({ documentId: row.id, bytes });
      return row;
    })
    .catch((err: { code?: string; cause?: { code?: string } }) => {
      if ((err.code ?? err.cause?.code) === "23503") return null;
      throw err;
    });
  if (!document) return badRequest("Collection not found.", 404);

  scheduleKnowledgeProcessing();
  return Response.json(document, { status: 201 });
}
