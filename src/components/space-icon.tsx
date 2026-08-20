import {
  BookOpen,
  BriefcaseBusiness,
  Building2,
  Code2,
  Database,
  Folder,
  Globe2,
  GraduationCap,
  Heart,
  Lightbulb,
  type LucideIcon,
  Megaphone,
  Palette,
  Rocket,
  ShieldCheck,
  Star,
  Users,
} from "lucide-react";

export const SPACE_ICON_OPTIONS: {
  value: string;
  label: string;
  Icon: LucideIcon;
}[] = [
  { value: "i:folder", label: "Folder", Icon: Folder },
  { value: "i:book", label: "Knowledge", Icon: BookOpen },
  { value: "i:users", label: "People", Icon: Users },
  { value: "i:briefcase", label: "Work", Icon: BriefcaseBusiness },
  { value: "i:building", label: "Company", Icon: Building2 },
  { value: "i:globe", label: "Global", Icon: Globe2 },
  { value: "i:shield", label: "Policies", Icon: ShieldCheck },
  { value: "i:lightbulb", label: "Ideas", Icon: Lightbulb },
  { value: "i:code", label: "Engineering", Icon: Code2 },
  { value: "i:rocket", label: "Launch", Icon: Rocket },
  { value: "i:star", label: "Featured", Icon: Star },
  { value: "i:heart", label: "Culture", Icon: Heart },
  { value: "i:graduation", label: "Learning", Icon: GraduationCap },
  { value: "i:palette", label: "Design", Icon: Palette },
  { value: "i:megaphone", label: "Marketing", Icon: Megaphone },
  { value: "i:database", label: "Data", Icon: Database },
];

export const SPACE_EMOJI_OPTIONS = [
  ["📚", "books knowledge"],
  ["📁", "folder files"],
  ["🏠", "home"],
  ["🏢", "company office"],
  ["👥", "people team"],
  ["🧭", "direction strategy"],
  ["🚀", "launch rocket"],
  ["💡", "ideas lightbulb"],
  ["🛠️", "tools operations"],
  ["⚙️", "settings engineering"],
  ["💻", "computer technology"],
  ["📊", "chart analytics"],
  ["📈", "growth metrics"],
  ["🧪", "experiment research"],
  ["🎨", "design creative"],
  ["📣", "marketing announcement"],
  ["🛡️", "security policy"],
  ["⚖️", "legal compliance"],
  ["💰", "finance money"],
  ["🧾", "expenses receipts"],
  ["🎯", "goals target"],
  ["✅", "tasks approved"],
  ["❤️", "culture heart"],
  ["🌍", "global world"],
  ["🌱", "growth sustainability"],
  ["🎓", "learning education"],
  ["🤝", "partners handshake"],
  ["🔧", "support maintenance"],
  ["📦", "product package"],
  ["🗺️", "roadmap map"],
  ["🔬", "science research"],
  ["📝", "notes writing"],
] as const;

export function SpaceIcon({
  value,
  className = "size-4",
}: {
  value: string;
  className?: string;
}) {
  const option = SPACE_ICON_OPTIONS.find((item) => item.value === value);
  if (option) return <option.Icon className={className} />;
  if (value && !value.startsWith("i:")) {
    return <span className="leading-none">{value}</span>;
  }
  return <Folder className={className} />;
}
