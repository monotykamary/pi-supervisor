export const extractPath = (args: Record<string, unknown> | undefined): string | null => {
  if (!args) return null;
  for (const key of ['path', 'file_path', 'filePath', 'file']) {
    if (typeof args[key] === 'string') return args[key] as string;
  }
  return null;
};
