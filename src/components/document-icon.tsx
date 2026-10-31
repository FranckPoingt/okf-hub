import { Blocks, FileText } from "lucide-react";

/** Artifacts get the same icon everywhere, matching the sidebar. */
export function DocumentIcon({ type }: { type?: string }) {
  return type?.toLocaleLowerCase() === "artifact" ? <Blocks /> : <FileText />;
}
