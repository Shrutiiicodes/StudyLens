import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Study Lens — AI-Powered Concept Mastery",
  description: "AI-Powered Foundational Concept Mastery Platform for CBSE Grade 4–10. Upload documents, build knowledge graphs, and master concepts through adaptive assessments.",
  keywords: ["education", "AI", "CBSE", "concept mastery", "adaptive learning", "knowledge graph"],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
