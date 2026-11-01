import { useAuth, useClerk } from "@clerk/react";
import { MessageSquareIcon, ServerIcon, SmartphoneIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { createPortal } from "react-dom";

import { MobileClientsUserProfilePage } from "./MobileClientsUserProfilePage";
import { LpChatUserProfilePage } from "./LpChatUserProfilePage";
import { LpConnectUserProfilePage } from "./LpConnectUserProfilePage";

export const LP_CONNECT_ACCOUNT_PAGES = [
  {
    label: "Mobile clients",
    url: "mobile-clients",
    icon: <SmartphoneIcon className="size-4" />,
    content: <MobileClientsUserProfilePage />,
  },
  {
    label: "LogicPacks Connect",
    url: "lp-connect",
    icon: <ServerIcon className="size-4" />,
    content: <LpConnectUserProfilePage />,
  },
  {
    label: "LogicPacks Chat",
    url: "lp-chat",
    icon: <MessageSquareIcon className="size-4" />,
    content: <LpChatUserProfilePage />,
  },
] as const;

export type LpConnectAccountPageUrl = (typeof LP_CONNECT_ACCOUNT_PAGES)[number]["url"];

type PortalTargets = Readonly<Record<string, HTMLDivElement | undefined>>;

/** Keep portals rendered while the modal can open; Clerk owns the custom-page DOM nodes. */
export function useLpConnectAccountPage(): {
  readonly open: ((page?: LpConnectAccountPageUrl) => void) | null;
  readonly portals: ReactNode;
} {
  const clerk = useClerk();
  const { isSignedIn } = useAuth();
  const [targets, setTargets] = useState<PortalTargets>({});

  const open = (page: LpConnectAccountPageUrl = "lp-connect") => {
    const setTarget = (key: string, element: HTMLDivElement | undefined) =>
      setTargets((current) => ({ ...current, [key]: element }));
    clerk.openUserProfile({
      __experimental_startPath: `/${page}`,
      customPages: LP_CONNECT_ACCOUNT_PAGES.map((page) => ({
        label: page.label,
        url: page.url,
        mount: (element: HTMLDivElement) => setTarget(`content:${page.url}`, element),
        unmount: () => setTarget(`content:${page.url}`, undefined),
        mountIcon: (element: HTMLDivElement) => setTarget(`icon:${page.url}`, element),
        unmountIcon: () => setTarget(`icon:${page.url}`, undefined),
      })),
    });
  };

  const portals = LP_CONNECT_ACCOUNT_PAGES.flatMap((page) => {
    const content = targets[`content:${page.url}`];
    const icon = targets[`icon:${page.url}`];
    return [
      content ? createPortal(page.content, content, `content:${page.url}`) : null,
      icon ? createPortal(page.icon, icon, `icon:${page.url}`) : null,
    ];
  });

  return { open: isSignedIn ? open : null, portals };
}
