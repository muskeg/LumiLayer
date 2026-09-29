export function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const exportFileName = (base: string, kind: string) => `${base.replace(/[^\w.-]+/g, '_') || 'lumilayer'}-${kind}.3mf`;
