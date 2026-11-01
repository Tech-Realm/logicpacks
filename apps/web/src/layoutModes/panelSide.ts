import { createContext, useContext } from "react";

/** Which side of the chat column the workspace panel sits on; Dev puts it on the left. */
export type WorkspacePanelSide = "left" | "right";

export const WorkspacePanelSideContext = createContext<WorkspacePanelSide>("right");

export const useWorkspacePanelSide = () => useContext(WorkspacePanelSideContext);
