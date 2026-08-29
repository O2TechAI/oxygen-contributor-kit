const packet = (caseId, projectLabel, records) => ({
  schema: "oxygen.story-first-fixture-input/target",
  caseId,
  projectLabel,
  privacyState: "public_safe_synthetic",
  records,
});

const record = (id, timestamp, actorId, text) => ({ id, timestamp, actorId, text });

export const storyFirstSemanticCases = [
  {
    id: "zero-insights",
    title: "Complete ordinary arc with no reusable learning",
    input: packet("zero-insights", "Community Garden Roster", [
      record("zero-record-1", "2034-04-02T09:00:00Z", "actor-coordinator", "The coordinator copied the approved volunteer roster into the weekend schedule."),
      record("zero-record-2", "2034-04-02T10:00:00Z", "actor-coordinator", "The coordinator checked every assigned slot against the approved roster; all names and times matched."),
      record("zero-record-3", "2034-04-02T11:00:00Z", "actor-coordinator", "The schedule was posted to the demonstration notice board with no unresolved change."),
    ]),
  },
  {
    id: "one-insight",
    title: "One bounded learning beside tempting generic advice",
    input: packet("one-insight", "Museum Label Trial", [
      record("one-record-1", "2034-05-01T09:00:00Z", "actor-curator", "The curator prepared two label layouts for the same synthetic exhibit text."),
      record("one-record-2", "2034-05-01T10:00:00Z", "actor-visitor-researcher", "The visitor researcher observed that readers missed the date only when it was separated from the object name."),
      record("one-record-3", "2034-05-01T11:00:00Z", "actor-curator", "The curator moved the date beside the object name and the next trial no longer missed it."),
      record("one-record-4", "2034-05-01T11:05:00Z", "actor-observer", "An observer suggested that all museums should make every label shorter, but this trial did not compare label length."),
    ]),
  },
  {
    id: "multiple-sparse-insights",
    title: "One coherent long Chapter with independent sparse learnings",
    input: packet("multiple-sparse-insights", "Seed Vault Inventory", [
      record("many-record-1", "2034-06-03T08:00:00Z", "actor-librarian", "The librarian began one inventory arc by matching packet labels to shelf cards."),
      record("many-record-2", "2034-06-03T09:00:00Z", "actor-librarian", "A shelf card matched the packet name but its checksum differed, so the librarian stopped the copy instead of treating the name as identity."),
      record("many-record-3", "2034-06-03T10:00:00Z", "actor-operator", "The operator found that an older packet had reused the name and assigned a stable inventory identifier before the copy resumed."),
      record("many-record-4", "2034-06-03T11:00:00Z", "actor-librarian", "The librarian validated the corrected inventory on one shelf before extending the same procedure to the remaining shelves."),
      record("many-record-5", "2034-06-03T12:00:00Z", "actor-operator", "The operator completed the same inventory arc; packet identity and staged validation both remained recorded."),
    ]),
  },
  {
    id: "mundane-setup",
    title: "Ordinary setup retained because a later diagnosis depends on it",
    input: packet("mundane-setup", "Aquarium Light Timer", [
      record("setup-record-1", "2034-07-01T08:00:00Z", "actor-caretaker", "The caretaker wrote down that the demonstration timer was installed in manual mode before any test began."),
      record("setup-record-2", "2034-07-01T09:00:00Z", "actor-technician", "The technician ran the first scheduled-light test; the lamp did not start."),
      record("setup-record-3", "2034-07-01T10:00:00Z", "actor-technician", "The technician used the recorded setup to identify manual mode as the reason scheduling had no effect."),
      record("setup-record-4", "2034-07-02T08:00:00Z", "actor-caretaker", "After changing to schedule mode, the caretaker observed one successful timed start."),
    ]),
  },
  {
    id: "unsupported-lesson",
    title: "Plausible lesson remains unsupported",
    input: packet("unsupported-lesson", "Paper Glider Trial", [
      record("unsupported-record-1", "2034-08-04T13:00:00Z", "actor-builder", "The builder tested one paper glider indoors and it veered left."),
      record("unsupported-record-2", "2034-08-04T13:10:00Z", "actor-reviewer", "The reviewer noted a bent left wing but did not establish whether the bend caused the veer."),
      record("unsupported-record-3", "2034-08-04T13:20:00Z", "actor-builder", "No second glider or corrected-wing trial was available, so the cause remained unresolved."),
    ]),
  },
  {
    id: "failed-approach",
    title: "A failed approach changes the next action",
    input: packet("failed-approach", "Library Cart Route", [
      record("failure-record-1", "2034-09-09T09:00:00Z", "actor-route-planner", "The route planner ordered stops alphabetically to make the list easy to scan."),
      record("failure-record-2", "2034-09-09T10:00:00Z", "actor-cart-operator", "The cart operator tried the alphabetical route and had to cross the same hallway four times."),
      record("failure-record-3", "2034-09-09T11:00:00Z", "actor-route-planner", "Because the first route failed, the planner reordered stops by adjacent rooms."),
      record("failure-record-4", "2034-09-09T12:00:00Z", "actor-cart-operator", "The second trial finished with one hallway crossing; adoption beyond this trial remained undecided."),
    ]),
  },
  {
    id: "status-noise",
    title: "Repeated no-change status is compressed without losing transitions",
    input: packet("status-noise", "Weather Display Refresh", [
      record("noise-record-1", "2034-10-10T09:00:00Z", "actor-operator", "Refresh is running; no result yet."),
      record("noise-record-2", "2034-10-10T09:05:00Z", "actor-operator", "Refresh is still running; no result yet."),
      record("noise-record-3", "2034-10-10T09:10:00Z", "actor-operator", "Refresh remains running; no result yet."),
      record("noise-record-4", "2034-10-10T09:15:00Z", "actor-monitor", "The monitor reported a timeout and changed the next action from waiting to checking the cache."),
      record("noise-record-5", "2034-10-10T09:30:00Z", "actor-operator", "The operator cleared the synthetic cache and the next refresh completed."),
    ]),
  },
  {
    id: "multi-people-attribution",
    title: "Multiple actors retain exact attribution without invented consensus",
    input: packet("multi-people-attribution", "Community Radio Rehearsal", [
      record("people-record-1", "2034-11-12T15:00:00Z", "actor-producer", "The producer proposed moving the rehearsal earlier."),
      record("people-record-2", "2034-11-12T15:10:00Z", "actor-engineer", "The engineer reported that the studio would be available at the earlier time."),
      record("people-record-3", "2034-11-12T15:20:00Z", "actor-host", "The host asked to keep the original time; no response to that request was recorded."),
      record("people-record-4", "2034-11-12T15:30:00Z", "actor-producer", "The producer recorded the schedule as unresolved pending a later decision."),
    ]),
  },
];
