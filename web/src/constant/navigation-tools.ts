import { Clapperboard } from "lucide-react";

export const navigationTools = [
    {
        slug: "director",
        icon: Clapperboard,
    },
] as const;

export type NavigationToolSlug = (typeof navigationTools)[number]["slug"];
