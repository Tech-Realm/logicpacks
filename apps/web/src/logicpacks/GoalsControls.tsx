import type { EnvironmentId, ThreadId } from "@logicpacks/contracts";
import {
  CheckIcon,
  EyeIcon,
  FlagIcon,
  MessageSquareIcon,
  PlusIcon,
  ShieldAlertIcon,
  TargetIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { type ComposerBannerStackItem } from "../components/chat/ComposerBannerStack";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPopup,
  SheetTitle,
} from "../components/ui/sheet";
import { Switch } from "../components/ui/switch";
import { Textarea } from "../components/ui/textarea";
import { toastManager } from "../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/utils";
import { useProjectPresence } from "../presence/usePresence";
import { usePrimaryEnvironmentId } from "../state/environments";
import {
  blankMilestone,
  closeGoalsPanel,
  composeGoal,
  canDecide,
  decideLater,
  decisionFor,
  formatDue,
  formFromGoal,
  formProblem,
  goalAttention,
  goalsApi,
  GOAL_STATE_LABEL,
  guardrailsText,
  resolutionLabel,
  openGoalsPanel,
  planFromForm,
  STATUS_LABEL,
  stopWatching,
  storeGoal,
  tasksForThread,
  useGoalsUi,
  useProjectGoals,
  watchThread,
  type GoalForm,
  type LpGoal,
  type LpGoalAssignee,
  type PendingDecision,
  type LpDecision,
  type LpDecisionAction,
  type LpGoalPerson,
  type LpMilestone,
  type MilestoneForm,
} from "./goals";
import { LpFace } from "./PeopleControls";
import { useLogicPacksSession } from "./store";

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong.";

/** Runs one goal action, stores what the server returned, and toasts a refusal. */
async function act(title: string, run: () => Promise<{ goal: LpGoal }>): Promise<LpGoal | null> {
  try {
    const { goal } = await run();
    storeGoal(goal);
    return goal;
  } catch (error) {
    toastManager.add({ type: "error", title, description: errorText(error) });
    return null;
  }
}

function useGoalsEnabled(environmentId: EnvironmentId | null) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { session } = useLogicPacksSession(false);
  return session !== null && environmentId !== null && environmentId === primaryEnvironmentId;
}

function BetaBadge() {
  return (
    <Badge size="sm" variant="outline" data-testid="lp-goals-beta">
      Beta
    </Badge>
  );
}

/** An expert's portrait, or a person's ink initial. */
export function AssigneeFace({
  assignee,
  className,
}: {
  assignee: Pick<LpGoalAssignee, "name" | "expertId">;
  className?: string;
}) {
  if (assignee.expertId !== null) {
    return (
      <img
        alt=""
        aria-hidden
        src={`/experts/${assignee.expertId}.svg`}
        className={cn("size-6 shrink-0 rounded-full bg-well ring-2 ring-background", className)}
      />
    );
  }
  return <LpFace name={assignee.name} here={false} {...(className ? { className } : {})} />;
}

function StatusChip({ milestone }: { milestone: LpMilestone }) {
  const live = milestone.status === "in_progress";
  return (
    <Badge
      size="sm"
      variant={milestone.status === "approved" ? "default" : "outline"}
      data-lp-dot={live ? "pulse" : milestone.status === "pending" ? "ring" : ""}
      data-testid="lp-milestone-status"
      data-status={milestone.status}
    >
      {STATUS_LABEL[milestone.status]}
    </Badge>
  );
}

function ProgressBar({ goal }: { goal: LpGoal }) {
  return (
    <div
      className="flex items-center gap-2"
      data-testid="lp-goal-progress"
      data-percent={goal.progress.percent}
    >
      <div className="h-1 flex-1 overflow-hidden rounded-full bg-well">
        <div
          className="h-full rounded-full bg-foreground transition-[width] duration-(--lp-dur-3) ease-lp"
          style={{ width: `${goal.progress.percent}%` }}
        />
      </div>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {goal.progress.approved}/{goal.progress.total} approved
      </span>
    </div>
  );
}

function Guardrails({ milestone }: { milestone: LpMilestone }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-2xs font-medium text-muted-foreground">Guardrails</p>
      <ul className="flex flex-wrap gap-1" data-testid="lp-milestone-guardrails">
        {guardrailsText(milestone.scope).map((line) => (
          <li
            key={line}
            className="rounded-pill border border-hairline px-2 py-0.5 font-mono text-2xs text-foreground/80"
          >
            {line}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Criteria({ milestone }: { milestone: LpMilestone }) {
  if (milestone.criteria.length === 0) return null;
  const reported = new Map(milestone.report.map((entry) => [entry.criterion, entry]));
  return (
    <div className="flex flex-col gap-1">
      <p className="text-2xs font-medium text-muted-foreground">Done when</p>
      <ul className="flex flex-col gap-0.5" data-testid="lp-milestone-criteria">
        {milestone.criteria.map((criterion) => {
          const entry = reported.get(criterion);
          return (
            <li key={criterion} className="flex items-start gap-1.5 text-xs text-foreground/85">
              <span
                aria-hidden
                className={cn(
                  "mt-1 size-2 shrink-0 rounded-full border",
                  entry?.met ? "border-foreground bg-foreground" : "border-hairline-strong",
                )}
              />
              <span>
                {criterion}
                {entry?.evidence ? (
                  <span className="text-muted-foreground"> · {entry.evidence}</span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ── Decision requests (drift, reviews; later merges, spend, outside access) ──

const TONE_VARIANT = { primary: "default", default: "outline", quiet: "ghost" } as const;

const ACTION_ICON: Record<string, ReactNode> = {
  message: <MessageSquareIcon aria-hidden />,
  watch: <EyeIcon aria-hidden />,
  approve: <CheckIcon aria-hidden />,
};

/**
 * The actions of one request, rendered from the record: a note box when an action
 * needs one (open from the start when the main action does), client actions (Watch)
 * handled here, the rest posted to /decide.
 */
function DecisionActions({
  goal,
  request,
  size = "xs",
  onClient,
}: {
  goal: LpGoal;
  request: LpDecision;
  size?: "xs" | "sm";
  onClient?: (action: LpDecisionAction) => void;
}) {
  const noteFirst = request.actions.some((action) => action.needsNote && action.tone === "primary");
  const [note, setNote] = useState("");
  const [noting, setNoting] = useState(noteFirst);
  const [busy, setBusy] = useState(false);
  const who = request.subject.who.name;
  const noteAction = request.actions.find((action) => action.needsNote);
  const decide = async (action: LpDecisionAction) => {
    if (action.inApp !== undefined) {
      onClient?.(action);
      return;
    }
    if (action.needsNote && !noting) {
      setNoting(true);
      return;
    }
    setBusy(true);
    const done = await act(`${action.label} did not go through`, () =>
      goalsApi.decide({
        goalId: goal.id,
        decisionId: request.id,
        action: action.id,
        ...(note.trim() ? { note: note.trim() } : {}),
      }),
    );
    setBusy(false);
    if (done !== null) {
      setNote("");
      setNoting(noteFirst);
      toastManager.add({
        type: "success",
        title:
          action.id === "message" ? `Sent to ${who}` : `${action.label}: ${request.subject.title}`,
        ...(action.id === "message" ? { description: "It is in their thread now." } : {}),
      });
    }
  };
  const quiet = request.actions.filter((action) => action.tone === "quiet");
  const main = request.actions.filter((action) => action.tone !== "quiet");
  const button = (action: LpDecisionAction) => (
    <Button
      key={action.id}
      size={size}
      variant={TONE_VARIANT[action.tone]}
      disabled={
        busy ||
        (action.inApp === "watch" && request.subject.threadId === null) ||
        (action.needsNote && noting && note.trim() === "")
      }
      data-testid={`lp-decision-${action.id}`}
      onClick={() => void decide(action)}
    >
      {ACTION_ICON[action.id] ?? null}
      {action.label}
    </Button>
  );
  return (
    <div
      className="flex w-full flex-col gap-1.5"
      data-testid="lp-decision-actions"
      data-kind={request.kind}
    >
      {noting && noteAction ? (
        <Textarea
          size="sm"
          value={note}
          placeholder={
            noteAction.id === "message"
              ? `Message ${who}, straight into their thread`
              : `What should ${who} change?`
          }
          data-testid="lp-decision-note"
          onChange={(event) => setNote(event.target.value)}
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5">
        {main.map(button)}
        {quiet.length > 0 ? <span className="flex-1" /> : null}
        {quiet.map(button)}
      </div>
    </div>
  );
}

/** "Mark done" with a note, for the assignee. */
function AssigneeActions({ goal, milestone }: { goal: LpGoal; milestone: LpMilestone }) {
  const [note, setNote] = useState("");
  const [finishing, setFinishing] = useState(false);
  const update = async (status: "in_progress" | "done") => {
    const done = await act("Not updated", () =>
      goalsApi.milestone({
        goalId: goal.id,
        milestoneId: milestone.id,
        status,
        ...(note.trim() ? { note: note.trim() } : {}),
      }),
    );
    if (done !== null) {
      setFinishing(false);
      setNote("");
    }
  };
  return (
    <div className="flex flex-col gap-1.5">
      {finishing ? (
        <Input
          size="sm"
          value={note}
          placeholder="What you did, for the review"
          data-testid="lp-task-done-note"
          onChange={(event) => setNote(event.target.value)}
        />
      ) : null}
      <div className="flex items-center gap-1">
        {milestone.status === "sent" || milestone.status === "changes_requested" ? (
          <Button
            size="xs"
            variant="ghost"
            data-testid="lp-task-start"
            onClick={() => void update("in_progress")}
          >
            Start
          </Button>
        ) : null}
        <Button
          size="xs"
          variant="outline"
          data-testid="lp-task-done"
          onClick={() => (finishing ? void update("done") : setFinishing(true))}
        >
          <FlagIcon aria-hidden />
          Mark done
        </Button>
      </div>
    </div>
  );
}

// ── The goal panel ──

function MilestoneRow({
  goal,
  milestone,
  onOpenThread,
}: {
  goal: LpGoal;
  milestone: LpMilestone;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  const own = milestone.assignee.userId === goal.viewer.participantId;
  const openDrift = goal.decisions.filter(
    (d) => d.kind === "goal.drift" && d.subject.milestoneId === milestone.id && d.status === "open",
  ).length;
  const review = decisionFor(goal, "goal.review", milestone.id);
  return (
    <li
      className="flex flex-col gap-2 border-b border-hairline px-3 py-3 last:border-b-0"
      data-testid="lp-milestone"
      data-milestone-id={milestone.id}
      data-assignee={milestone.assignee.name}
    >
      <div className="flex items-center gap-2">
        <AssigneeFace assignee={milestone.assignee} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium text-foreground">{milestone.title}</span>
          <span className="truncate text-xs text-muted-foreground">
            {milestone.assignee.name}
            {milestone.assignee.kind === "expert" ? " · Expert" : ""}
            {milestone.dueAtMs !== null ? ` · due ${formatDue(milestone.dueAtMs)}` : ""}
            {openDrift > 0 ? ` · ${openDrift} outside the guardrails` : ""}
          </span>
        </div>
        <StatusChip milestone={milestone} />
      </div>
      <Criteria milestone={milestone} />
      <Guardrails milestone={milestone} />
      {milestone.doneNote ? (
        <p className="text-xs text-foreground/80">“{milestone.doneNote}”</p>
      ) : null}
      {milestone.review?.verdict === "changes" && milestone.status === "changes_requested" ? (
        <p className="text-xs text-muted-foreground">Sent back: {milestone.review.note}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-1">
        {review !== undefined && canDecide(goal, review) ? (
          <DecisionActions goal={goal} request={review} />
        ) : null}
        {own &&
        goal.state === "active" &&
        milestone.threadId !== null &&
        milestone.status !== "approved" &&
        milestone.status !== "done" ? (
          <AssigneeActions goal={goal} milestone={milestone} />
        ) : null}
        {milestone.threadId !== null && !own ? (
          <Button
            size="xs"
            variant="ghost"
            data-testid="lp-milestone-watch"
            onClick={() => {
              watchThread(milestone.threadId!, milestone.assignee.name);
              closeGoalsPanel();
              onOpenThread(milestone.threadId as ThreadId);
            }}
          >
            <EyeIcon aria-hidden />
            Watch
          </Button>
        ) : null}
      </div>
    </li>
  );
}

/** Every request on the goal, newest first: drift and reviews, open and decided. */
function DecisionLog({ goal }: { goal: LpGoal }) {
  if (goal.decisions.length === 0) return null;
  return (
    <section className="flex flex-col gap-1.5" data-testid="lp-decision-log">
      <p className="text-xs font-medium text-muted-foreground">Decisions</p>
      <ul className="rounded-row border border-hairline">
        {goal.decisions.toReversed().map((request) => (
          <li
            key={request.id}
            className="flex flex-col gap-1 border-b border-hairline px-3 py-2 last:border-b-0"
            data-testid="lp-decision-entry"
            data-kind={request.kind}
            data-status={request.status}
          >
            <div className="flex items-center gap-2">
              <span
                aria-hidden
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  request.status === "open" ? "bg-foreground" : "border border-hairline-strong",
                )}
              />
              <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                {request.title}
              </span>
              <span className="shrink-0 text-2xs text-muted-foreground">
                {resolutionLabel(request)}
              </span>
            </div>
            {request.resolution?.note ? (
              <p className="ps-3.5 text-2xs text-muted-foreground">
                {request.resolution.by}: {request.resolution.note}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function GoalDetail({
  goal,
  onOpenThread,
}: {
  goal: LpGoal;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  const [editing, setEditing] = useState(goal.state === "draft" && goal.viewer.canManage);
  if (editing && goal.state === "draft") {
    return <GoalEditor goal={goal} onDone={() => setEditing(false)} />;
  }
  return (
    <div
      className="flex flex-col gap-4"
      data-testid="lp-goal-detail"
      data-goal-id={goal.id}
      data-state={goal.state}
    >
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <h3 className="min-w-0 flex-1 truncate text-lg font-normal">{goal.title}</h3>
          <Badge size="sm" variant="outline" data-lp-dot={goal.state === "active" ? "pulse" : ""}>
            {GOAL_STATE_LABEL[goal.state]}
          </Badge>
        </div>
        {goal.outcome ? <p className="text-sm text-foreground/80">{goal.outcome}</p> : null}
        <p className="text-xs text-muted-foreground">Set by {goal.ownerName}</p>
        <ProgressBar goal={goal} />
      </div>
      <ul className="rounded-row border border-hairline">
        {goal.milestones.map((milestone) => (
          <MilestoneRow
            key={milestone.id}
            goal={goal}
            milestone={milestone}
            onOpenThread={onOpenThread}
          />
        ))}
      </ul>
      <DecisionLog goal={goal} />
      {goal.viewer.canManage && goal.state === "active" ? (
        <div className="flex items-center justify-between gap-2 rounded-row border border-hairline px-3 py-2">
          <span className="flex flex-col">
            <span className="text-xs font-medium">AI check at turn end</span>
            <span className="text-2xs text-muted-foreground">
              A model reads each finished turn against the milestone (at most every 10 minutes).
            </span>
          </span>
          <Switch
            checked={goal.judge}
            data-testid="lp-goal-judge"
            onCheckedChange={(checked) =>
              void act("Not saved", () => goalsApi.edit({ goalId: goal.id, judge: checked }))
            }
          />
        </div>
      ) : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-2xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

const selectClass =
  "h-8 w-full rounded-row border border-hairline bg-transparent px-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

function MilestoneEditor({
  index,
  value,
  people,
  onChange,
  onRemove,
}: {
  index: number;
  value: MilestoneForm;
  people: ReadonlyArray<LpGoalPerson>;
  onChange: (next: MilestoneForm) => void;
  onRemove: () => void;
}) {
  const set = <K extends keyof MilestoneForm>(key: K, next: MilestoneForm[K]) =>
    onChange({ ...value, [key]: next });
  const known = people.some((person) => person.name === value.assignee);
  return (
    <li
      className="flex flex-col gap-2 border-b border-hairline px-3 py-3 last:border-b-0"
      data-testid="lp-goal-edit-milestone"
    >
      <div className="flex items-center gap-2">
        <span className="text-xs tabular-nums text-muted-foreground">{index + 1}</span>
        <Input
          size="sm"
          value={value.title}
          placeholder="What needs doing"
          aria-label={`Milestone ${index + 1} title`}
          data-testid="lp-goal-edit-milestone-title"
          onChange={(event) => set("title", event.target.value)}
        />
        <Button size="icon-xs" variant="ghost" aria-label="Remove milestone" onClick={onRemove}>
          <Trash2Icon aria-hidden />
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Who">
          <select
            className={selectClass}
            value={known ? value.assignee : ""}
            data-testid="lp-goal-edit-assignee"
            onChange={(event) => set("assignee", event.target.value)}
          >
            <option value="">
              {value.assignee && !known ? `${value.assignee}?` : "Pick someone"}
            </option>
            {people.map((person) => (
              <option
                key={`${person.kind}:${person.userId ?? person.expertId}`}
                value={person.name}
              >
                {person.name}
                {person.kind === "expert" ? " (expert)" : ""}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Due">
          <Input
            size="sm"
            type="date"
            value={value.due}
            data-testid="lp-goal-edit-due"
            onChange={(event) => set("due", event.target.value)}
          />
        </Field>
      </div>
      <Field label="Done when (one per line)">
        <Textarea
          size="sm"
          value={value.criteria}
          data-testid="lp-goal-edit-criteria"
          onChange={(event) => set("criteria", event.target.value)}
        />
      </Field>
      <fieldset className="flex flex-col gap-2 rounded-row border border-hairline p-2">
        <legend className="px-1 text-2xs font-medium text-muted-foreground">Guardrails</legend>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Only these paths">
            <Input
              size="sm"
              value={value.paths}
              placeholder="checkout/"
              data-testid="lp-goal-edit-paths"
              onChange={(event) => set("paths", event.target.value)}
            />
          </Field>
          <Field label="Never these">
            <Input
              size="sm"
              value={value.avoid}
              placeholder="api/"
              data-testid="lp-goal-edit-avoid"
              onChange={(event) => set("avoid", event.target.value)}
            />
          </Field>
          <Field label="Branch">
            <Input
              size="sm"
              value={value.branch}
              placeholder="any"
              onChange={(event) => set("branch", event.target.value)}
            />
          </Field>
          <label className="flex items-center justify-between gap-2 self-end pb-1.5 text-xs">
            New dependencies
            <Switch
              checked={value.newDependencies}
              onCheckedChange={(checked) => set("newDependencies", checked)}
            />
          </label>
        </div>
        <Field label="Other limits (one per line)">
          <Textarea
            size="sm"
            value={value.notes}
            placeholder="Don't change the API"
            onChange={(event) => set("notes", event.target.value)}
          />
        </Field>
      </fieldset>
    </li>
  );
}

function usePeople(projectId: string | null) {
  const [people, setPeople] = useState<{
    projectId: string;
    list: ReadonlyArray<LpGoalPerson>;
  } | null>(null);
  // oxlint-disable-next-line logicpacks/no-unreasoned-state-sync -- loads who can be assigned from the LogicPacks API when the editor opens
  useEffect(() => {
    if (projectId === null) return;
    let live = true;
    void goalsApi
      .people(projectId)
      .then((result) => {
        if (live) setPeople({ projectId, list: result.people });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [projectId]);
  return people !== null && people.projectId === projectId ? people.list : [];
}

function GoalEditor({
  goal,
  projectId,
  threadId,
  onDone,
}: {
  goal?: LpGoal;
  projectId?: string;
  threadId?: string | null;
  onDone: () => void;
}) {
  const people = usePeople(goal?.projectId ?? projectId ?? null);
  const [form, setForm] = useState<GoalForm>(() =>
    goal ? formFromGoal(goal) : { title: "", outcome: "", milestones: [blankMilestone()] },
  );
  const [busy, setBusy] = useState(false);
  const problem = formProblem(form);
  const save = async (confirm: boolean) => {
    setBusy(true);
    const plan = planFromForm(form);
    let saved =
      goal === undefined
        ? await act("Not saved", () =>
            goalsApi.create({ projectId: projectId!, threadId: threadId ?? null, plan }),
          )
        : await act("Not saved", () => goalsApi.edit({ goalId: goal.id, plan }));
    if (saved !== null && confirm) {
      saved = await act("Not sent", () => goalsApi.confirm(saved!.id));
      if (saved !== null) {
        const sent = saved.milestones.filter((m) => m.threadId !== null).length;
        toastManager.add({
          type: "success",
          title: `Sent ${sent} of ${saved.milestones.length} milestones`,
          description:
            sent < saved.milestones.length
              ? "The rest go out when those people open a thread here."
              : "Each one is in its owner's thread with its guardrails.",
        });
      }
    }
    setBusy(false);
    if (saved !== null) {
      openGoalsPanel(saved.id);
      onDone();
    }
  };
  return (
    <div className="flex flex-col gap-3" data-testid="lp-goal-editor" data-goal-id={goal?.id ?? ""}>
      {goal ? (
        <p className="text-xs text-muted-foreground">
          {goal.ownerName === goal.log[0]?.by
            ? "Draft"
            : `Drafted by ${goal.log[0]?.by ?? goal.ownerName}`}
          . Nothing is sent until you confirm.
        </p>
      ) : null}
      <Field label="Goal">
        <Input
          size="sm"
          value={form.title}
          placeholder="Ship saved cards in checkout"
          data-testid="lp-goal-edit-title"
          onChange={(event) => setForm({ ...form, title: event.target.value })}
        />
      </Field>
      <Field label="Outcome">
        <Textarea
          size="sm"
          value={form.outcome}
          placeholder="What done looks like for the whole goal"
          data-testid="lp-goal-edit-outcome"
          onChange={(event) => setForm({ ...form, outcome: event.target.value })}
        />
      </Field>
      <ul className="rounded-row border border-hairline">
        {form.milestones.map((milestone, index) => (
          <MilestoneEditor
            key={milestone.id ?? `new-${index}`}
            index={index}
            value={milestone}
            people={people}
            onChange={(next) =>
              setForm({
                ...form,
                milestones: form.milestones.map((current, at) => (at === index ? next : current)),
              })
            }
            onRemove={() =>
              setForm({ ...form, milestones: form.milestones.filter((_, at) => at !== index) })
            }
          />
        ))}
      </ul>
      <Button
        size="xs"
        variant="ghost"
        className="self-start"
        onClick={() => setForm({ ...form, milestones: [...form.milestones, blankMilestone()] })}
      >
        <PlusIcon aria-hidden />
        Add milestone
      </Button>
      {problem ? <p className="text-xs text-muted-foreground">{problem}</p> : null}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          disabled={busy || problem !== null}
          data-testid="lp-goal-confirm"
          onClick={() => void save(true)}
        >
          Confirm and send
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || problem !== null}
          data-testid="lp-goal-save"
          onClick={() => void save(false)}
        >
          Save draft
        </Button>
        {goal ? (
          <Button
            size="sm"
            variant="ghost-muted"
            disabled={busy}
            onClick={async () => {
              if ((await act("Not discarded", () => goalsApi.cancel(goal.id))) !== null) {
                openGoalsPanel(null);
                onDone();
              }
            }}
          >
            Discard
          </Button>
        ) : (
          <Button size="sm" variant="ghost-muted" onClick={onDone}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}

function GoalRow({ goal }: { goal: LpGoal }) {
  const openDrift = goal.decisions.filter(
    (request) => request.kind === "goal.drift" && request.status === "open",
  ).length;
  return (
    <li className="border-b border-hairline last:border-b-0">
      <button
        type="button"
        data-testid="lp-goal-row"
        data-goal-id={goal.id}
        className="flex w-full flex-col gap-2 px-3 py-3 text-start transition-colors duration-(--lp-dur-1) ease-lp hover:bg-accent"
        onClick={() => openGoalsPanel(goal.id)}
      >
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{goal.title}</span>
          {openDrift > 0 ? (
            <Badge size="sm" variant="outline" data-lp-dot="">
              {openDrift} off plan
            </Badge>
          ) : null}
          <Badge size="sm" variant="outline">
            {GOAL_STATE_LABEL[goal.state]}
          </Badge>
        </span>
        <span className="flex items-center gap-2">
          <span className="flex -space-x-1.5">
            {goal.milestones.slice(0, 5).map((milestone) => (
              <AssigneeFace key={milestone.id} assignee={milestone.assignee} className="size-5" />
            ))}
          </span>
          <span className="flex-1">
            <ProgressBar goal={goal} />
          </span>
        </span>
      </button>
    </li>
  );
}

function GoalsPanel({
  projectId,
  threadId,
  onOpenThread,
}: {
  projectId: string;
  threadId: string | null;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  const view = useProjectGoals(projectId);
  const { goalId, composing } = useGoalsUi();
  const goals = view?.goals.filter((goal) => goal.state !== "cancelled") ?? [];
  const selected = goalId === null ? undefined : view?.goals.find((goal) => goal.id === goalId);
  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pb-6"
      data-testid="lp-goals-panel"
    >
      {composing ? (
        <GoalEditor
          projectId={projectId}
          threadId={threadId}
          onDone={() => useGoalsUi.setState({ composing: false })}
        />
      ) : selected !== undefined ? (
        <>
          <Button
            size="xs"
            variant="ghost-muted"
            className="self-start"
            onClick={() => openGoalsPanel(null)}
          >
            All goals
          </Button>
          <GoalDetail
            key={`${selected.id}:${selected.state}`}
            goal={selected}
            onOpenThread={onOpenThread}
          />
        </>
      ) : view === null ? (
        <p className="text-sm text-muted-foreground">Loading</p>
      ) : goals.length === 0 ? (
        <div
          className="flex flex-col items-start gap-3 rounded-row border border-hairline p-4"
          data-testid="lp-goals-empty"
        >
          <p className="text-sm text-foreground">
            Delegate to a teammate or an outside team, with guardrails.
          </p>
          <p className="text-xs text-muted-foreground">
            Ask your agent, for example "ask Omar to build the saved cards list in checkout/ by
            Friday, and Priya to cover it with tests". It drafts the goal here; you confirm, and
            each milestone lands in that person's thread. You hear when work goes outside the
            guardrails, and you approve what is done.
          </p>
          <Button size="sm" variant="outline" data-testid="lp-goal-new" onClick={composeGoal}>
            <PlusIcon aria-hidden />
            New goal
          </Button>
        </div>
      ) : (
        <>
          <ul className="rounded-row border border-hairline">
            {goals.toReversed().map((goal) => (
              <GoalRow key={goal.id} goal={goal} />
            ))}
          </ul>
          <Button
            size="xs"
            variant="ghost"
            className="self-start"
            data-testid="lp-goal-new"
            onClick={composeGoal}
          >
            <PlusIcon aria-hidden />
            New goal
          </Button>
        </>
      )}
    </div>
  );
}

// ── Decision dialog: open requests whose presentation is "dialog" (drift today) ──

function DecisionDialog({
  projectId,
  onOpenThread,
}: {
  projectId: string;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  const view = useProjectGoals(projectId);
  const later = useGoalsUi((state) => state.laterIds);
  const pending = goalAttention(view?.goals ?? []).dialogs.filter(
    (entry) => !later.includes(entry.request.id),
  );
  const current: PendingDecision | undefined = pending[0];
  return (
    <Dialog
      open={current !== undefined}
      onOpenChange={(open) => {
        if (!open && current) decideLater(current.request.id);
      }}
    >
      {current ? (
        <DialogPopup
          className="max-w-lg"
          data-testid="lp-decision-dialog"
          data-kind={current.request.kind}
          data-decision-id={current.request.id}
        >
          <DialogHeader>
            <DialogTitle>
              <span className="flex items-start gap-2">
                <ShieldAlertIcon aria-hidden className="mt-1 size-4.5 shrink-0" />
                <span data-testid="lp-decision-title">{current.request.title}</span>
              </span>
            </DialogTitle>
            <DialogDescription>
              {current.goal.title} · {current.request.subject.title} · raised by{" "}
              {current.request.requester.name}
              {pending.length > 1 ? ` · ${pending.length - 1} more` : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <DecisionBody pending={current} />
          </DialogPanel>
          <DialogFooter>
            <DecisionActions
              key={current.request.id}
              goal={current.goal}
              request={current.request}
              size="sm"
              onClient={() => {
                const threadId = current.request.subject.threadId;
                if (threadId === null) return;
                watchThread(threadId, current.request.subject.who.name);
                decideLater(current.request.id);
                onOpenThread(threadId as ThreadId);
              }}
            />
          </DialogFooter>
        </DialogPopup>
      ) : null}
    </Dialog>
  );
}

/** Summary, evidence and the milestone's guardrails, for the dialog and the cards. */
function DecisionBody({ pending }: { pending: PendingDecision }) {
  const { request, milestone } = pending;
  return (
    <div className="flex flex-col gap-3">
      {request.summary ? (
        <div className="flex items-center gap-2">
          {milestone ? <AssigneeFace assignee={milestone.assignee} /> : null}
          <p className="text-sm text-foreground" data-testid="lp-decision-summary">
            {request.summary}
          </p>
        </div>
      ) : null}
      {request.detail.length > 0 ? (
        <ul
          className="rounded-row border border-hairline bg-well/50 px-3 py-2 font-mono text-xs"
          data-testid="lp-decision-detail"
        >
          {request.detail.map((line) => (
            <li key={line} className="truncate">
              {line}
            </li>
          ))}
        </ul>
      ) : null}
      {milestone ? <Guardrails milestone={milestone} /> : null}
    </div>
  );
}

/** Goals (Beta) in the top bar's tool tray: the panel and the drift dialog live here. */
export function LpGoalsButton({
  projectId,
  environmentId,
  threadId,
  onOpenThread,
}: {
  projectId: string;
  environmentId: EnvironmentId | null;
  threadId: string | null;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  const enabled = useGoalsEnabled(environmentId);
  const view = useProjectGoals(enabled ? projectId : null);
  const open = useGoalsUi((state) => state.panelOpen);
  if (!enabled) return null;
  const attention = goalAttention(view?.goals ?? []);
  const count = attention.dialogs.length + attention.cards.length + attention.drafts.length;
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="xs"
              variant="ghost"
              data-testid="lp-goals-open"
              data-tour="goals"
              aria-label={count > 0 ? `Goals (Beta), ${count} need you` : "Goals (Beta)"}
              className="relative"
              onClick={() => openGoalsPanel(useGoalsUi.getState().goalId)}
            />
          }
        >
          <TargetIcon aria-hidden />
          {count > 0 ? (
            <span
              aria-hidden
              data-testid="lp-goals-attention"
              className="absolute top-1 right-1 size-1.5 rounded-full bg-foreground"
            />
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="bottom">Goals (Beta): delegate with guardrails</TooltipPopup>
      </Tooltip>
      <Sheet open={open} onOpenChange={(next) => (next ? undefined : closeGoalsPanel())}>
        <SheetPopup side="right" className="w-full max-w-lg" data-testid="lp-goals-sheet">
          <SheetHeader>
            <SheetTitle>
              <span className="flex items-center gap-2">
                Goals <BetaBadge />
              </span>
            </SheetTitle>
            <SheetDescription>
              Plan the work with your agent, send it to your team or experts, and keep it inside the
              guardrails.
            </SheetDescription>
          </SheetHeader>
          {open ? (
            <GoalsPanel projectId={projectId} threadId={threadId} onOpenThread={onOpenThread} />
          ) : null}
        </SheetPopup>
      </Sheet>
      <DecisionDialog projectId={projectId} onOpenThread={onOpenThread} />
    </>
  );
}

// ── Cards above a thread's composer ──

function WatchDescription({
  environmentId,
  projectId,
  threadId,
  name,
}: {
  environmentId: EnvironmentId | null;
  projectId: string;
  threadId: string;
  name: string;
}) {
  const presence = useProjectPresence(environmentId, projectId as never).filter(
    (entry) => entry.threadId === threadId,
  );
  if (presence.length === 0) {
    return (
      <span data-testid="lp-watch-presence">
        {name} and their agent are not in a file right now.
      </span>
    );
  }
  return (
    <span className="flex flex-col gap-0.5" data-testid="lp-watch-presence">
      {presence.map((entry) => (
        <span key={entry.key}>
          {entry.actor.name} {entry.location.activity}
          {entry.location.path ? (
            <span className="font-mono text-2xs"> {entry.location.path}</span>
          ) : null}
        </span>
      ))}
    </span>
  );
}

/**
 * Goal cards for the open thread: the draft its agent planned (planner), each task
 * assigned to it (assignee), milestones waiting for this viewer's review, and the
 * Watch strip while following someone.
 */
export function useLpGoalCards(input: {
  projectId: string | null;
  threadId: string | null;
  environmentId: EnvironmentId | null;
}): ReadonlyArray<ComposerBannerStackItem> {
  const enabled = useGoalsEnabled(input.environmentId);
  const view = useProjectGoals(enabled ? input.projectId : null);
  const watching = useGoalsUi((state) => state.watching);
  if (!enabled || view === null || input.threadId === null || input.projectId === null) return [];
  const threadId = input.threadId;
  const items: ComposerBannerStackItem[] = [];
  if (watching !== null && watching.threadId === threadId) {
    items.push({
      id: `lp-watch:${threadId}`,
      variant: "info",
      icon: <EyeIcon />,
      title: <span data-testid="lp-watch-bar">Watching {watching.name}</span>,
      description: (
        <WatchDescription
          environmentId={input.environmentId}
          projectId={input.projectId}
          threadId={threadId}
          name={watching.name}
        />
      ),
      dismissLabel: "Stop watching",
      onDismiss: stopWatching,
    });
  }
  const attention = goalAttention(view.goals);
  for (const goal of attention.drafts.filter((draft) => draft.plannedInThreadId === threadId)) {
    items.push({
      id: `lp-goal-draft:${goal.id}`,
      variant: "info",
      icon: <TargetIcon />,
      title: (
        <span data-testid="lp-goal-draft-card" data-goal-id={goal.id}>
          Goal draft: {goal.title}
        </span>
      ),
      description: `${goal.milestones.length} milestone${goal.milestones.length === 1 ? "" : "s"} for ${Array.from(
        new Set(goal.milestones.map((m) => m.assignee.name)),
      ).join(", ")}. Nothing is sent until you confirm.`,
      actions: (
        <Button
          size="xs"
          variant="outline"
          data-testid="lp-goal-draft-review"
          onClick={() => openGoalsPanel(goal.id)}
        >
          Review
        </Button>
      ),
    });
  }
  for (const { goal, milestone } of tasksForThread(view.goals, threadId)) {
    const own = milestone.assignee.userId === view.viewer.participantId;
    items.push({
      id: `lp-goal-task:${milestone.id}`,
      variant: milestone.status === "changes_requested" ? "warning" : "default",
      icon: <FlagIcon />,
      title: (
        <span
          data-testid="lp-goal-task-card"
          data-milestone-id={milestone.id}
          data-status={milestone.status}
        >
          {milestone.status === "changes_requested" ? "Sent back" : "Task"} from {goal.ownerName}:{" "}
          {milestone.title}
        </span>
      ),
      description: `${goal.title}${milestone.dueAtMs !== null ? ` · due ${formatDue(milestone.dueAtMs)}` : ""} · ${STATUS_LABEL[milestone.status]}`,
      // Long content goes in children: the banner row keeps title and description on one line.
      children: (
        <div className="flex flex-col gap-2">
          <Criteria milestone={milestone} />
          <Guardrails milestone={milestone} />
          {own && milestone.status !== "done" ? (
            <AssigneeActions goal={goal} milestone={milestone} />
          ) : null}
        </div>
      ),
    });
  }
  // Requests shown as cards (reviews today), from the record alone.
  for (const pending of attention.cards) {
    const { goal, request } = pending;
    items.push({
      id: `lp-decision:${request.id}`,
      variant: "info",
      icon: <CheckIcon />,
      title: (
        <span data-testid="lp-decision-card" data-kind={request.kind} data-decision-id={request.id}>
          {request.title}
        </span>
      ),
      description: `Check it against the criteria · ${goal.title}`,
      children: (
        <div className="flex flex-col gap-3">
          <DecisionBody pending={pending} />
          <DecisionActions goal={goal} request={request} />
        </div>
      ),
    });
  }
  return items;
}
