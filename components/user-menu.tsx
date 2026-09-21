"use client";

import { useClerk, useUser } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { Layers, LogOut, User as UserIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useEnvironment } from "@/components/environment-provider";
import { environmentStatusLabel } from "@/lib/environments";

export function UserMenu() {
  const { isLoaded, isSignedIn, user } = useUser();
  const { signOut } = useClerk();
  const router = useRouter();
  const { selectedEnvironment, clearEnvironment } = useEnvironment();

  if (!isLoaded || !isSignedIn) return null;

  const email = user.primaryEmailAddress?.emailAddress ?? "";
  const displayName = user.fullName?.trim() || email || "Account";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="gap-2 text-foreground hover:bg-muted"
        >
          <UserIcon className="h-4 w-4" />
          <span className="hidden max-w-[180px] truncate sm:inline">
            {displayName}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={12} className="w-56">
        <DropdownMenuLabel className="flex flex-col gap-0.5">
          <span className="text-sm font-medium leading-none">
            {user.fullName ?? "Account"}
          </span>
          {email && (
            <span className="text-xs font-normal text-muted-foreground">
              {email}
            </span>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {/* Back to the selector — the environment is a session-level choice,
            so it is changed from here rather than from a control on the page. */}
        <DropdownMenuItem
          onSelect={() => router.push("/select-environment")}
          className="gap-2"
        >
          <Layers className="h-4 w-4" />
          <span className="flex flex-col leading-tight">
            <span>Change environment</span>
            {selectedEnvironment && (
              <span className="text-xs font-normal text-muted-foreground">
                {selectedEnvironment.name} ·{" "}
                {environmentStatusLabel(selectedEnvironment.production)}
              </span>
            )}
          </span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            // The environment belongs to the session that chose it: signing
            // out must not leave the next sign-in inside it.
            clearEnvironment();
            signOut({ redirectUrl: "/sign-in" });
          }}
          className="gap-2 text-destructive focus:text-destructive"
        >
          <LogOut className="h-4 w-4" />
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
