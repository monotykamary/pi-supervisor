export const extractPath = (args: Record<string, unknown>): string | null => {
  for (const key of ['path', 'file_path', 'filePath', 'file']) {
    if (typeof args[key] === 'string') return args[key] as string;
  }
  return null;
};
