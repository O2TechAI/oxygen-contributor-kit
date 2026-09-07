# Export your Claude conversations and import them into Oxygen

This guide is for contributors importing their own claude.ai conversations. Request the export from Claude, download it to your computer, then run the Oxygen importer locally. The importer does not upload your data.

## 1. Request a Claude export

1. Sign in to [claude.ai](https://claude.ai) with the account that contains your conversations, using the web app or Claude Desktop. Mobile apps do not offer this export.
2. Open your profile menu, then **Settings → Privacy**.
3. Select **Export data**.
4. Wait for a download link at the email address associated with your account.
5. Open the link while signed in to that account and save the archive locally. The link expires 24 hours after delivery; request another export if it expires.

These steps apply to individual accounts. Team and Enterprise exports are available to the organization's Primary Owner through **Organization settings → Data and privacy**. See Claude's [individual export instructions](https://support.claude.com/en/articles/9450526-export-your-claude-data) or [organization export instructions](https://support.claude.com/en/articles/13346720-export-your-organization-s-data).

The importer supports the following files when present in the export:

| File | Contents | Oxygen output |
|---|---|---|
| `conversations.json` | Conversation history | One trajectory per supported conversation |
| `memories.json` | Conversation memory and memory files | `memory/claudeai-memory/` |
| `projects.json` or `projects/*.json` | Project information and knowledge documents | `memory/claudeai-projects/` |
| `design_chats/*.json` | Design/Artifacts conversations | One trajectory per supported conversation |
| `users.json` | Account details such as email and name | Not imported |

Export layouts can change. If your export arrives as several archives, import each supported archive into a separate, empty output directory. The importer does not combine arbitrary archive fragments or overwrite an existing run.

## 2. If the export email does not arrive

- Check Spam and Promotions, and search for messages mentioning Anthropic or an export.
- Verify the email address on your Claude account. Organization mail filters may block the message before it reaches your inbox; check with your mail administrator if needed.
- Allow time for the export to be generated. If it still does not arrive, consult Claude support before repeatedly requesting exports.
- If a download fails, confirm that you are signed in to the correct account. An expired link requires a new export.

This importer reads Claude exports. A similarly named `conversations.json` from ChatGPT uses a different format and is not supported by this tool.

## 3. Import into Oxygen

Run commands from the repository root. You can pass the ZIP directly without extracting it:

```bash
python3 tools/ingest/import_anthropic_export.py ~/Downloads/data-export.zip \
  --out work/claude-export-run
```

The importer also accepts an extracted export directory or an individual `conversations.json`. Passing that individual file imports conversations only; use the archive or directory to include supported project, memory, and Design/Artifacts files.

Choose a new or empty `--out` directory. Converted conversations go under `trajectories/`, project and memory documents under `memory/`, and the run summary is written to `index.json`. Review its `warnings`: some unsupported conversation entries are skipped with warnings, while invalid JSON, unsafe paths, or an incompatible top-level layout stop the import.

Use the canonical Viewer for the subsequent Oxygen workflow. See the [ingest tools README](README.md) for commands and the [ingest Skill](../../skills/oxygen-ingest-project-history/SKILL.md) for the approved input boundary and workflow handoff.

## 4. Optional: identify speakers in meeting audio

This is a separate input path for recordings, not a requirement for importing Claude chats. Audio transcription runs locally on CPU. Install the optional audio dependencies in the project-local environment described in the [ingest tools README](README.md); model downloads may require network access, but the audio is processed locally.

For optional speaker diarization, use your own Hugging Face account and token:

1. Sign in to [Hugging Face](https://huggingface.co).
2. Accept the access conditions for [speaker-diarization-3.1](https://huggingface.co/pyannote/speaker-diarization-3.1) and [segmentation-3.0](https://huggingface.co/pyannote/segmentation-3.0).
3. Create a token with read access in **Settings → Access Tokens**.
4. Make it available through `HF_TOKEN`, or the supported `--hf-token` option, and import your recording with its actual meeting date:

```bash
python3 tools/ingest/import_meeting.py meeting.m4a \
  --out work/meeting-run --date 2026-08-30
```

Without a token, transcription still works if the audio dependencies are installed, but speaker labels fall back to `Speaker A` with a warning. This is not verified speaker attribution. The README includes a PowerShell example that clears a temporary `HF_TOKEN` afterward.

## 5. Keep raw exports private

- Archives can contain your full conversation history. Keep them and the unreviewed import output in private local storage, not a public or shared folder.
- Imported output starts with `review_status=pending` and `publication_approved=false`. Automatic filtering is not approval to publish: complete Oxygen's Privacy preparation and your own final review before creating a reviewed release.
