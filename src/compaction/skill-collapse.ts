const SKILL_TAG_RE = /^-?\s*<skill\s+name="([^"]+)"/;
const SKILL_CLOSE_RE = /^-?\s*<\/skill>/;

export const collapseSkillLines = (lines: string[]): string[] => {
  const result: string[] = [];
  const seenSkills = new Set<string>();
  let insideSkill = false;

  for (const line of lines) {
    const skillMatch = line.match(SKILL_TAG_RE);
    if (skillMatch) {
      insideSkill = true;
      const name = skillMatch[1];
      if (!seenSkills.has(name)) {
        seenSkills.add(name);
        result.push(`[skill: ${name}]`);
      }
      continue;
    }
    if (insideSkill) {
      if (SKILL_CLOSE_RE.test(line)) insideSkill = false;
      continue;
    }
    result.push(line);
  }
  return result;
};

const SKILL_BLOCK_RE = /<skill\s+name="([^"]+)"[^>]*>[\s\S]*?(?:<\/skill>|$)/g;
export const collapseSkillText = (text: string): string =>
  text.replace(SKILL_BLOCK_RE, (_, name) => `[skill: ${name}]`);
