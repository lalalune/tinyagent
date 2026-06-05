import Link from "next/link";
import { Logo } from "@/components/Logo";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 text-center">
      <Logo withWordmark={false} className="scale-150" />
      <h1 className="mt-6 text-3xl font-bold text-slate-900">404</h1>
      <p className="mt-2 max-w-sm text-sm text-slate-500">
        This page drifted out of orbit. Your agents are safe.
      </p>
      <Link href="/" className="btn-primary mt-6">
        Back to home
      </Link>
    </div>
  );
}
