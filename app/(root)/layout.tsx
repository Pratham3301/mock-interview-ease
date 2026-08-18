import Link from "next/link";
import Image from "next/image";
import { ReactNode } from "react";
import { redirect } from "next/navigation";

import { isAuthenticated } from "@/lib/actions/auth.action";
import {
  GeminiApiKeyControl,
  GeminiApiKeyProvider,
} from "@/components/GeminiApiKeyProvider";

const Layout = async ({ children }: { children: ReactNode }) => {
  const isUserAuthenticated = await isAuthenticated();
  if (!isUserAuthenticated) redirect("/sign-in");

  return (
    <GeminiApiKeyProvider>
      <div className="root-layout">
        <nav className="flex items-center justify-between gap-4">
          <Link href="/" className="flex items-center gap-2">
            <Image src="/logo.svg" alt="MockMate Logo" width={38} height={32} />
            <h2 className="text-primary-100">PrepWise</h2>
          </Link>
          <GeminiApiKeyControl />
        </nav>

        {children}
      </div>
    </GeminiApiKeyProvider>
  );
};

export default Layout;
