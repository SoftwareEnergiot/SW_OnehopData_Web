"use client";

import type { ReactNode } from "react";
import { toast } from "sonner";
import { RotateCcw, Save } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface ViewPickerItem {
  key: string;
  label: string;
  /** Heading the item is listed under. */
  group?: string;
}

interface ViewPickerProps {
  /** The trigger's content, e.g. an icon and "Columns". */
  trigger: ReactNode;
  title: string;
  items: ViewPickerItem[];
  selected: readonly string[];
  onToggle: (key: string) => void;
  onSelectAll: () => void;
  onClear: () => void;
  /** Keep the selection for next time; false when the browser refused. */
  onSave: () => boolean;
  onReset: () => void;
  /** The selection differs from what would load next time. */
  unsaved: boolean;
  hasSavedView: boolean;
}

/**
 * A checklist of columns or charts with "save view" / "reset to default". The
 * selection applies at once; saving keeps it in this browser for next time.
 */
export function ViewPicker({
  trigger,
  title,
  items,
  selected,
  onToggle,
  onSelectAll,
  onClear,
  onSave,
  onReset,
  unsaved,
  hasSavedView,
}: ViewPickerProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          {trigger}
          <span className="text-xs text-muted-foreground">
            ({selected.length}/{items.length})
          </span>
          {unsaved && (
            <span
              className="h-1.5 w-1.5 rounded-full bg-primary"
              aria-label="unsaved changes"
            />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-96 w-72 overflow-y-auto">
        <DropdownMenuLabel>{title}</DropdownMenuLabel>
        <DropdownMenuItem
          disabled={!unsaved}
          onSelect={() => {
            if (onSave()) toast.success("View saved in this browser.");
            else toast.error("This browser did not let the view be saved.");
          }}
        >
          <Save className="h-4 w-4" />
          Save view
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!hasSavedView && !unsaved}
          onSelect={onReset}
        >
          <RotateCcw className="h-4 w-4" />
          Reset to default
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <div className="flex gap-1 px-1 py-1">
          <Button variant="ghost" size="sm" className="h-7 flex-1" onClick={onSelectAll}>
            Select all
          </Button>
          <Button variant="ghost" size="sm" className="h-7 flex-1" onClick={onClear}>
            Deselect all
          </Button>
        </div>
        {items.map((item, index) => {
          // A heading wherever the group changes from the item before.
          const heading =
            item.group !== items[index - 1]?.group ? item.group : undefined;
          return (
            <div key={item.key}>
              {heading && (
                <DropdownMenuLabel className="pt-2 text-xs font-normal text-muted-foreground">
                  {heading}
                </DropdownMenuLabel>
              )}
              <DropdownMenuCheckboxItem
                checked={selected.includes(item.key)}
                // Keep the menu open so several can be toggled in one pass.
                onSelect={(e) => e.preventDefault()}
                onCheckedChange={() => onToggle(item.key)}
              >
                {item.label}
              </DropdownMenuCheckboxItem>
            </div>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
