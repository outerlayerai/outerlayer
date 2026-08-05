import { FileTypeResult } from "./types";

const promptFileExtensions = [".prompt.mdx"];
const componentFileExtensions = [".mdx", ".md"];
const datasetFileExtensions = [".jsonl"];
const schemaFileExtensions = [".json"];

export type { FileTypeResult };

export function resolveFileType(fileName: string): FileTypeResult {
  let name = "";
  let extension = "";
  let type = "";

  const promptFileExtension = promptFileExtensions.find((ext) =>
    fileName.endsWith(ext)
  );
  const componentFileExtension = componentFileExtensions.find((ext) =>
    fileName.endsWith(ext)
  );
  const datasetFileExtension = datasetFileExtensions.find((ext) =>
    fileName.endsWith(ext)
  );
  const schemaFileExtension = schemaFileExtensions.find((ext) =>
    fileName.endsWith(ext)
  );

  if (promptFileExtension) {
    name = fileName.replace(promptFileExtension, "");
    extension = promptFileExtension;
    type = "prompt";
  } else if (componentFileExtension) {
    name = fileName.replace(componentFileExtension, "");
    extension = componentFileExtension;
    type = "component";
  } else if (datasetFileExtension) {
    name = fileName.replace(datasetFileExtension, "");
    extension = datasetFileExtension;
    type = "dataset";
  } else if (schemaFileExtension) {
    name = fileName.replace(schemaFileExtension, "");
    extension = schemaFileExtension;
    type = "schema";
  }

  return { name, extension, type };
}

export function isDatasetFile(filePath: string): boolean {
  return datasetFileExtensions.some((ext) => filePath.endsWith(ext));
}
