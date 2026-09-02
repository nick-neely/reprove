import type { ReactNode } from "react";

export const metadata = {
  title: "Reprove control plane",
};

const RootLayout = ({ children }: { children: ReactNode }) => (
  <html lang="en">
    <body>{children}</body>
  </html>
);

export default RootLayout;
