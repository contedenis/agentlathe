"use client";

import { SkillForm } from "@/components/forms/skill-form";
import { ResourceList } from "@/components/resource-list";
import type { listSkills } from "@/lib/queries";

type SkillRow = Awaited<ReturnType<typeof listSkills>>[number];

export function SkillsList({ skills }: { skills: SkillRow[] }) {
  return (
    <ResourceList
      eyebrow="Workshop · skills"
      title="Skills"
      description="On-demand knowledge: the description is always injected, the content is loaded on demand."
      items={skills}
      columns={[
        {
          header: "Description",
          cell: (skill) => skill.description,
          className: "max-w-md truncate text-muted-foreground",
        },
      ]}
      searchPlaceholder="Search by name…"
      emptyTitle="No skills yet"
      emptyDescription="Skills are on-demand knowledge: the description is always injected, the content is loaded on demand."
      createLabel="New skill"
      emptyActionLabel="Create skill"
      sheetTitleCreate="New skill"
      sheetTitleEdit="Edit skill"
      endpointBase={(id) => `/api/skills/${id}`}
      resourceLabel="the skill"
      redirectTo="/skills"
      FormComponent={SkillForm}
    />
  );
}
