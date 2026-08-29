import { db } from "@agentlathe/db";
import { sql } from "drizzle-orm";

export async function GET() {
  try {
    await db.execute(sql`select 1`);
    return Response.json({ status: "ok" });
  } catch (err) {
    console.error(err);
    return Response.json({ status: "error" }, { status: 503 });
  }
}
