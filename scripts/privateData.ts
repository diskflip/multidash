import { mkdirSync } from "node:fs";
import { join } from "node:path";

const privateRoot = process.env.PRIVATE_DATA_DIR?.trim() || ".private";

function privatePath(directory: string, filename: string): string {
  const target = join(privateRoot, directory);
  mkdirSync(target, { recursive: true });
  return join(target, filename);
}

export const accountExportPath = (filename: string) =>
  privatePath("account-exports", filename);

export const accountReportPath = (filename: string) =>
  privatePath("account-reports", filename);
