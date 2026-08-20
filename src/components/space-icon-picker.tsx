import { useState } from "react";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs.tsx";
import {
  SPACE_EMOJI_OPTIONS,
  SPACE_ICON_OPTIONS,
  SpaceIcon,
} from "./space-icon.tsx";

export function SpaceIconPicker({
  value,
  label,
  onChange,
}: {
  value: string;
  label: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"icon" | "emoji">(
    value && !value.startsWith("i:") ? "emoji" : "icon",
  );
  const search = query.trim().toLocaleLowerCase();
  const icons = SPACE_ICON_OPTIONS.filter((item) =>
    !search || item.label.toLocaleLowerCase().includes(search)
  );
  const emojis = SPACE_EMOJI_OPTIONS.filter(([, keywords]) =>
    !search || keywords.includes(search)
  );
  const select = (next: string) => {
    onChange(next);
    setOpen(false);
    setQuery("");
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setTab(value && !value.startsWith("i:") ? "emoji" : "icon");
        else setQuery("");
      }}
    >
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="icon-lg"
            aria-label={label}
          />
        }
      >
        <span className="flex size-5 items-center justify-center text-base">
          <SpaceIcon value={value} className="size-5" />
        </span>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 gap-0 overflow-hidden p-0"
        aria-label="Space icon picker"
      >
        <Tabs
          value={tab}
          onValueChange={(next) => setTab(next as "icon" | "emoji")}
        >
          <div className="flex items-center border-b px-2 pt-2">
            <TabsList variant="line" className="flex-1 justify-start">
              <TabsTrigger value="icon" className="flex-none px-3">
                Icons
              </TabsTrigger>
              <TabsTrigger value="emoji" className="flex-none px-3">
                Emojis
              </TabsTrigger>
            </TabsList>
            {value && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => select("")}
              >
                Remove
              </Button>
            )}
          </div>
          <div className="p-2">
            <Input
              type="search"
              value={query}
              placeholder="Search…"
              aria-label="Search icons and emojis"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <TabsContent value="icon" className="px-2 pb-2">
            <div className="grid grid-cols-8 gap-1">
              {icons.map(({ value: optionValue, label: optionLabel, Icon }) => (
                <Button
                  type="button"
                  variant={value === optionValue ? "secondary" : "ghost"}
                  size="icon-lg"
                  title={optionLabel}
                  aria-label={optionLabel}
                  key={optionValue}
                  onClick={() => select(optionValue)}
                >
                  <Icon />
                </Button>
              ))}
            </div>
            {!icons.length && (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No icons found.
              </p>
            )}
          </TabsContent>
          <TabsContent value="emoji" className="px-2 pb-2">
            <div className="grid grid-cols-8 gap-1">
              {emojis.map(([emoji, keywords]) => (
                <Button
                  type="button"
                  variant={value === emoji ? "secondary" : "ghost"}
                  size="icon-lg"
                  className="text-lg"
                  title={keywords.split(" ")[0]}
                  aria-label={keywords}
                  key={emoji}
                  onClick={() => select(emoji)}
                >
                  {emoji}
                </Button>
              ))}
            </div>
            {!emojis.length && (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No emojis found.
              </p>
            )}
          </TabsContent>
        </Tabs>
      </PopoverContent>
    </Popover>
  );
}
