import {
  parseStoryReviewSession,
  storyReviewSessionSemanticJson,
  type StoryReviewSession,
} from "./story-review-session.ts";
import {
  validActivatedSourceRevision,
  validNonnegativeAuthorityCounter,
} from "./authority-validation.mjs";

export type StoryReviewSessionSaveRequest = {
  workflowRunId: string;
  expectedVersion: number;
  sourceRevision: number;
  session: StoryReviewSession;
};

export type StoryReviewSessionSaveAcknowledgement = {
  saved: boolean;
  noChange: boolean;
  serverVersion: number;
  sourceRevision: number;
  persistedAt: string;
};

export type StoryReviewSessionPersistenceStatus = "durable" | "dirty" | "saving" | "conflict" | "failed";

export class StoryReviewSessionPersistenceError extends Error {
  readonly code: string;

  constructor(code: string, message = code) {
    super(message);
    this.name = "StoryReviewSessionPersistenceError";
    this.code = code;
  }
}

type Scheduler = {
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
};

type QueueOptions = {
  save(request: StoryReviewSessionSaveRequest): Promise<StoryReviewSessionSaveAcknowledgement>;
  scheduler?: Scheduler;
  debounceMs?: number;
  onStatus?(state: StoryReviewSessionPersistenceState): void;
};

export type StoryReviewSessionPersistenceState = {
  status: StoryReviewSessionPersistenceStatus;
  serverVersion: number;
  sourceRevision: number | null;
  persistedAt: string | null;
  errorCode: string | null;
};

export type StoryReviewHandoffAuthority = {
  workflowRunId: string;
  serverVersion: number;
  sourceRevision: number;
};

type Snapshot = { session: StoryReviewSession; semantic: string };
type Waiter = { resolve: () => void; reject: (error: Error) => void };

const defaultScheduler: Scheduler = {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer),
};

function reviewSessionSemanticJson(value: unknown) {
  const session = parseStoryReviewSession(value);
  return session ? storyReviewSessionSemanticJson(session) : null;
}

/** Debounced single-flight persistence. An acknowledgement advances only the
 * exact snapshot captured by its request; a later dirty snapshot is then sent
 * with the newly acknowledged server version. */
export class StoryReviewSessionPersistenceQueue {
  private readonly save: QueueOptions["save"];
  private readonly scheduler: Scheduler;
  private readonly debounceMs: number;
  private readonly onStatus?: QueueOptions["onStatus"];
  private workflowRunId = "";
  private serverVersion = 0;
  private sourceRevision: number | null = null;
  private persistedAt: string | null = null;
  private acknowledgedSemantic: string | null = null;
  private latest: Snapshot | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private status: StoryReviewSessionPersistenceStatus = "failed";
  private terminalError: Error | null = null;
  private errorCode: string | null = null;
  private generation = 0;
  private waiters: Waiter[] = [];

  constructor(options: QueueOptions) {
    this.save = options.save;
    this.scheduler = options.scheduler || defaultScheduler;
    this.debounceMs = options.debounceMs ?? 400;
    this.onStatus = options.onStatus;
  }

  initialize(value: {
    workflowRunId: string;
    serverVersion: number;
    sourceRevision: number;
    session: StoryReviewSession | null;
    persistedAt?: string | null;
  }) {
    if (!validNonnegativeAuthorityCounter(value.serverVersion)
      || !validActivatedSourceRevision(value.sourceRevision)) {
      throw new StoryReviewSessionPersistenceError("STORY_SESSION_STATE_INVALID");
    }
    this.cancelTimer();
    this.generation += 1;
    this.rejectWaiters(new Error("Story review persistence was reloaded"));
    this.workflowRunId = value.workflowRunId;
    this.serverVersion = value.serverVersion;
    this.sourceRevision = value.sourceRevision;
    this.persistedAt = value.persistedAt || null;
    this.acknowledgedSemantic = reviewSessionSemanticJson(value.session);
    this.latest = value.session ? this.snapshot(value.session) : null;
    this.terminalError = null;
    this.errorCode = null;
    this.status = "durable";
    this.notify();
  }

  invalidate() {
    this.cancelTimer();
    this.generation += 1;
    this.workflowRunId = "";
    this.sourceRevision = null;
    this.latest = null;
    this.acknowledgedSemantic = null;
    const conflict = new StoryReviewSessionPersistenceError(
      "STORY_SESSION_SOURCE_CONFLICT",
      "Story review source changed before persistence completed",
    );
    this.terminalError = conflict;
    this.errorCode = conflict.code;
    this.status = "conflict";
    this.rejectWaiters(this.terminalError);
    this.notify();
  }

  schedule(value: StoryReviewSession) {
    if (this.terminalError || this.sourceRevision === null) return;
    const snapshot = this.snapshot(value);
    if (snapshot.session.workflowRunId !== this.workflowRunId) {
      this.fail(new StoryReviewSessionPersistenceError("STORY_SESSION_STATE_INVALID"));
      return;
    }
    this.latest = snapshot;
    this.cancelTimer();
    if (!this.inFlight && snapshot.semantic === this.acknowledgedSemantic) {
      this.status = "durable";
      this.notify();
      this.settleWaiters();
      return;
    }
    this.status = this.inFlight ? "saving" : "dirty";
    this.notify();
    if (!this.inFlight) {
      this.timer = this.scheduler.setTimeout(() => {
        this.timer = null;
        this.pump();
      }, this.debounceMs);
    }
  }

  flush(value?: StoryReviewSession) {
    if (value) this.schedule(value);
    this.cancelTimer();
    if (this.terminalError) return Promise.reject(this.terminalError);
    const promise = new Promise<void>((resolve, reject) => this.waiters.push({ resolve, reject }));
    this.pump();
    this.settleWaiters();
    return promise;
  }

  isDurable(value: StoryReviewSession) {
    return !this.terminalError
      && reviewSessionSemanticJson(value) === this.acknowledgedSemantic;
  }

  getState(): StoryReviewSessionPersistenceState {
    return {
      status: this.status,
      serverVersion: this.serverVersion,
      sourceRevision: this.sourceRevision,
      persistedAt: this.persistedAt,
      errorCode: this.errorCode,
    };
  }

  private snapshot(value: StoryReviewSession): Snapshot {
    const session = parseStoryReviewSession(value);
    const semantic = reviewSessionSemanticJson(session);
    if (!session || !semantic) throw new StoryReviewSessionPersistenceError("STORY_SESSION_STATE_INVALID");
    return { session, semantic };
  }

  private cancelTimer() {
    if (this.timer !== null) this.scheduler.clearTimeout(this.timer);
    this.timer = null;
  }

  private pump() {
    if (this.inFlight || this.terminalError || !this.latest || this.sourceRevision === null) return;
    if (this.latest.semantic === this.acknowledgedSemantic) {
      this.status = "durable";
      this.notify();
      this.settleWaiters();
      return;
    }
    const snapshot = this.latest;
    const generation = this.generation;
    const request: StoryReviewSessionSaveRequest = {
      workflowRunId: this.workflowRunId,
      expectedVersion: this.serverVersion,
      sourceRevision: this.sourceRevision,
      session: snapshot.session,
    };
    this.status = "saving";
    this.notify();
    const operation = this.save(request).then((acknowledgement) => {
      if (generation !== this.generation) return;
      const versionMatches = acknowledgement.saved
        ? acknowledgement.serverVersion === request.expectedVersion + 1
        : acknowledgement.noChange && (acknowledgement.serverVersion === request.expectedVersion
          || (request.expectedVersion === 0 && acknowledgement.serverVersion === 1));
      if (acknowledgement.sourceRevision !== request.sourceRevision
        || !validActivatedSourceRevision(acknowledgement.sourceRevision)
        || !validNonnegativeAuthorityCounter(acknowledgement.serverVersion)
        || acknowledgement.saved === acknowledgement.noChange
        || !versionMatches
        || typeof acknowledgement.persistedAt !== "string"
        || !acknowledgement.persistedAt) {
        throw new StoryReviewSessionPersistenceError("STORY_SESSION_STATE_INVALID");
      }
      this.serverVersion = acknowledgement.serverVersion;
      this.sourceRevision = acknowledgement.sourceRevision;
      this.persistedAt = acknowledgement.persistedAt;
      this.acknowledgedSemantic = snapshot.semantic;
    }).catch((error: unknown) => {
      if (generation !== this.generation) return;
      const failure = error instanceof Error ? error : new Error("Story review persistence failed");
      this.fail(failure);
    }).finally(() => {
      if (this.inFlight !== operation) return;
      this.inFlight = null;
      if (this.terminalError) return;
      if (this.latest?.semantic !== this.acknowledgedSemantic) {
        this.status = "dirty";
        this.notify();
        this.pump();
      } else {
        this.status = "durable";
        this.notify();
        this.settleWaiters();
      }
    });
    this.inFlight = operation;
  }

  private fail(error: Error) {
    this.terminalError = error;
    this.errorCode = error instanceof StoryReviewSessionPersistenceError ? error.code : null;
    this.status = this.errorCode?.includes("CONFLICT") ? "conflict" : "failed";
    this.notify();
    this.rejectWaiters(error);
  }

  private settleWaiters() {
    if (this.inFlight || this.timer !== null || this.terminalError
      || (this.latest && this.latest.semantic !== this.acknowledgedSemantic)) return;
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter.resolve();
  }

  private rejectWaiters(error: Error) {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter.reject(error);
  }

  private notify() {
    this.onStatus?.(this.getState());
  }
}

/** Run a handoff only after the latest canonical browser snapshot has an exact
 * durable acknowledgement. An edit during the wait causes another flush. */
export async function runDurableStoryReviewHandoff<T>(options: {
  persistence: StoryReviewSessionPersistenceQueue;
  currentSession(): StoryReviewSession | null;
  handoff(authority: StoryReviewHandoffAuthority): Promise<T>;
}) {
  for (;;) {
    const session = options.currentSession();
    if (!session) throw new StoryReviewSessionPersistenceError("STORY_SESSION_STATE_INVALID");
    await options.persistence.flush(session);
    const latest = options.currentSession();
    if (!latest || !options.persistence.isDurable(latest)) continue;
    const state = options.persistence.getState();
    const current = options.currentSession();
    if (!current || !options.persistence.isDurable(current)) continue;
    if (state.status !== "durable"
      || !validNonnegativeAuthorityCounter(state.serverVersion)
      || !validActivatedSourceRevision(state.sourceRevision)
      || current.workflowRunId !== latest.workflowRunId) {
      throw new StoryReviewSessionPersistenceError("STORY_SESSION_STATE_INVALID");
    }
    return options.handoff({
      workflowRunId: current.workflowRunId,
      serverVersion: state.serverVersion,
      sourceRevision: Number(state.sourceRevision),
    });
  }
}
