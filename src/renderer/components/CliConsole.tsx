import { useEffect, useMemo, useRef, useState } from 'react';
import { AiConnector, AI_TASK_LABELS } from '@shared/types/connector';
import { AiJob } from '@shared/types/job';

interface JobLog {
  task: AiJob['task'];
  connectorId: string | null;
  lines: string[];
  /** True while this job is still in the queue's active set. */
  running: boolean;
}

const MAX_TRACKED_JOBS = 12;
const MAX_LINES_PER_JOB = 2000;

/**
 * Always-mounted so it keeps capturing output even while closed -- a slide-out
 * console showing exactly what each CLI connector is doing, live, with a
 * timestamp on every line. Built after a job sat at "running" for ten minutes
 * with nothing on screen to say whether it was working or wedged.
 */
export default function CliConsole() {
  const [open, setOpen] = useState(false);
  const [jobs, setJobs] = useState<Map<string, JobLog>>(new Map());
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [connectors, setConnectors] = useState<AiConnector[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void window.valutique.connectors.getAll().then(setConnectors);
  }, []);

  // Track which jobs are active so a section header can say "running" vs
  // "finished" without waiting for another CLI line to arrive.
  useEffect(() => {
    return window.valutique.queue.onState((state) => {
      const activeIds = new Set(state.active.map((job) => job.id));
      setJobs((current) => {
        const next = new Map(current);
        for (const job of state.active) {
          if (!next.has(job.id)) next.set(job.id, { task: job.task, connectorId: job.connectorId, lines: [], running: true });
        }
        for (const [id, log] of next) {
          if (log.running && !activeIds.has(id)) next.set(id, { ...log, running: false });
        }
        // Cap how many job transcripts stick around so a long session doesn't
        // grow this without bound.
        if (next.size > MAX_TRACKED_JOBS) {
          const finishedOldestFirst = [...next.entries()].filter(([, log]) => !log.running);
          for (const [id] of finishedOldestFirst.slice(0, next.size - MAX_TRACKED_JOBS)) next.delete(id);
        }
        return next;
      });
    });
  }, []);

  useEffect(() => {
    return window.valutique.queue.onCliOutput((event) => {
      setJobs((current) => {
        const existing = current.get(event.jobId);
        const lines = [...(existing?.lines ?? []), `[${formatTime(event.at)}] ${event.line}`].slice(-MAX_LINES_PER_JOB);
        const next = new Map(current);
        next.set(event.jobId, { task: existing?.task ?? 'identify', connectorId: existing?.connectorId ?? null, lines, running: true });
        return next;
      });
    });
  }, []);

  // Opening mid-run: backfill whatever the job already produced before this
  // panel existed to hear it, rather than only showing lines from now on.
  useEffect(() => {
    if (!open) return;
    void (async () => {
      for (const [jobId, log] of jobs) {
        if (log.running && log.lines.length === 0) {
          const backfill = await window.valutique.queue.getLiveLog(jobId);
          if (backfill) {
            setJobs((current) => {
              const existing = current.get(jobId);
              if (!existing || existing.lines.length > 0) return current;
              const next = new Map(current);
              next.set(jobId, { ...existing, lines: backfill.split('\n') });
              return next;
            });
          }
        }
      }
    })();
    // Only on open -- live updates after that arrive via onCliOutput.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const jobList = useMemo(() => [...jobs.entries()].sort((a, b) => (a[1].running === b[1].running ? 0 : a[1].running ? -1 : 1)), [jobs]);

  useEffect(() => {
    if (!selectedJobId && jobList.length > 0) setSelectedJobId(jobList[0][0]);
  }, [jobList, selectedJobId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [selectedJobId, jobs]);

  const connectorName = (id: string | null) => (id ? connectors.find((c) => c.id === id)?.name ?? 'Deleted connector' : '—');
  const runningCount = jobList.filter(([, log]) => log.running).length;
  const selected = selectedJobId ? jobs.get(selectedJobId) : null;

  return (
    <>
      <button className={`console-toggle${runningCount > 0 ? ' pulse' : ''}`} onClick={() => setOpen((v) => !v)} title="CLI console">
        {'>_'} Console{runningCount > 0 ? ` (${runningCount})` : ''}
      </button>

      <div className={`console-drawer${open ? ' open' : ''}`}>
        <div className="console-header">
          <strong>CLI console</strong>
          <span className="text-muted" style={{ fontSize: 12 }}>
            Live output from Claude Code / Gemini CLI jobs, timestamped.
          </span>
          <button className="btn-link" style={{ marginLeft: 'auto' }} onClick={() => setOpen(false)}>
            Close
          </button>
        </div>

        {jobList.length === 0 ? (
          <p className="text-muted" style={{ padding: 16, fontSize: 13 }}>
            Nothing has run through a CLI connector yet this session.
          </p>
        ) : (
          <>
            <div className="console-job-list">
              {jobList.map(([jobId, log]) => (
                <button
                  key={jobId}
                  className={`console-job${jobId === selectedJobId ? ' selected' : ''}`}
                  onClick={() => setSelectedJobId(jobId)}
                >
                  <span className={`pill${log.running ? ' pill-warn' : ''}`} style={{ marginRight: 6 }}>
                    {log.running ? 'running' : 'done'}
                  </span>
                  {AI_TASK_LABELS[log.task] ?? log.task} · {connectorName(log.connectorId)}
                </button>
              ))}
            </div>

            <div className="console-output" ref={scrollRef}>
              {selected && selected.lines.length > 0 ? (
                selected.lines.map((line, index) => (
                  <div key={index} className="console-line">
                    {line}
                  </div>
                ))
              ) : (
                <div className="text-muted">Waiting for output…</div>
              )}
            </div>
          </>
        )}
      </div>

      {open && <div className="console-scrim" onClick={() => setOpen(false)} />}
    </>
  );
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
