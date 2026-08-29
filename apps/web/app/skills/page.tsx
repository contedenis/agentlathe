import { SkillsList } from "@/components/skills-list";
import { listSkills } from "@/lib/queries";

export default async function SkillsPage() {
  const skills = await listSkills();
  return <SkillsList skills={skills} />;
}
