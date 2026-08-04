import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OKF Hub — Design partner workflow",
  description: "A clickable narrative for connecting, authoring, and discovering trusted company knowledge.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
