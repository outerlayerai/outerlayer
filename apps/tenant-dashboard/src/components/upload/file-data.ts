// File-metadata helpers. `RejectionFiles` is the sole consumer, so these live
// alongside it in the upload family rather than in a standalone primitive.

interface ExtendFile extends File {
  preview?: string;
  path?: string;
  lastModifiedDate?: string;
}

// ----------------------------------------------------------------------

export function fileTypeByUrl(fileUrl = '') {
  return (fileUrl && fileUrl.split('.').pop()) || '';
}

// ----------------------------------------------------------------------

export function fileNameByUrl(fileUrl: string) {
  return fileUrl.split('/').pop();
}

// ----------------------------------------------------------------------

export function fileData(file: ExtendFile | string) {
  // Url
  if (typeof file === 'string') {
    return {
      key: file,
      preview: file,
      name: fileNameByUrl(file),
      type: fileTypeByUrl(file),
    };
  }

  // File
  return {
    key: file.preview,
    name: file.name,
    size: file.size,
    path: file.path,
    type: file.type,
    preview: file.preview,
    lastModified: file.lastModified,
    lastModifiedDate: file.lastModifiedDate,
  };
}
