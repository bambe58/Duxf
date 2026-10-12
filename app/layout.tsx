import type { ReactNode } from "react";

export const metadata = { title: "DuoFin" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="it">
      <body>{children}</body>
    </html>
  );
}
