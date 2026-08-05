"use client";

/**
 * Run wizard: pick a qualified repo → task set → two configs → trials +
 * budget → confirm (restates cost + MDE estimate). Emits an
 * EvalRunRequest for the runner. The "Sample scenario" control is a DEMO
 * stand-in while the section runs on the seeded fake runner (no backend yet);
 * it drives the three verdict tiers for acceptance and disappears when the
 * real run backend is wired in.
 */

import { useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Slider,
  Stack,
  Step,
  StepLabel,
  Stepper,
  TextField,
  Typography,
} from "@mui/material";
import type { Verdict } from "@outerlayer/report-card";
import type { EvalRunRequest, WizardConfig } from "./fake-runner";

const STEPS = ["Tasks", "Configs", "Trials & budget", "Confirm"];

const LAUNCHERS: WizardConfig["launcher"][] = ["claude-code", "codex"];

function estimateMde(nTasks: number, trials: number): number {
  // Rough pre-run MDE at an assumed discordance of 0.25.
  const discordance = 0.25;
  return 1.96 * Math.sqrt(discordance / (nTasks * Math.min(trials, 3)));
}

export function EvalWizard({
  open,
  onClose,
  onRun,
  repoLabel,
}: {
  open: boolean;
  onClose: () => void;
  onRun: (request: EvalRunRequest) => void;
  /** The app's linked repo — fixed context, not a choice (from app.git_connection). */
  repoLabel: string;
}) {
  const [step, setStep] = useState(0);
  const [nTasks, setNTasks] = useState(84);
  const [configA, setConfigA] = useState<WizardConfig>({ id: "opus-4.8", launcher: "claude-code", model: "claude-opus-4-8" });
  const [configB, setConfigB] = useState<WizardConfig>({ id: "glm-5.2", launcher: "claude-code", model: "glm-5.2" });
  const [trials, setTrials] = useState(3);
  const [budget, setBudget] = useState(90);
  const [scenario, setScenario] = useState<Verdict>("directional");

  const taskIds = Array.from({ length: nTasks }, (_v, i) => `task-${String(i + 1).padStart(3, "0")}`);
  const mde = estimateMde(nTasks, trials);
  const estCost = nTasks * 2 * trials * 0.18;

  const reset = () => setStep(0);
  const close = () => {
    reset();
    onClose();
  };
  const run = () => {
    onRun({ repoLabel, taskIds, configs: [configA, configB], trialsPerTask: trials, budgetUsd: budget, scenario });
    close();
  };

  const configField = (label: string, cfg: WizardConfig, set: (c: WizardConfig) => void) => (
    <Stack spacing={1.5} sx={{ flex: 1 }}>
      <Typography variant="subtitle2">{label}</Typography>
      <TextField size="small" label="Config id" value={cfg.id} onChange={(e) => set({ ...cfg, id: e.target.value })} />
      <TextField size="small" select label="Launcher" value={cfg.launcher} onChange={(e) => set({ ...cfg, launcher: e.target.value as WizardConfig["launcher"] })}>
        {LAUNCHERS.map((l) => (
          <MenuItem key={l} value={l}>{l}</MenuItem>
        ))}
      </TextField>
      <TextField size="small" label="Model" value={cfg.model} onChange={(e) => set({ ...cfg, model: e.target.value })} />
    </Stack>
  );

  return (
    <Dialog open={open} onClose={close} maxWidth="sm" fullWidth data-testid="eval-wizard">
      <DialogTitle>New benchmark</DialogTitle>
      <DialogContent>
        <Stepper activeStep={step} sx={{ my: 2 }}>
          {STEPS.map((label) => (
            <Step key={label}>
              <StepLabel>{label}</StepLabel>
            </Step>
          ))}
        </Stepper>

        {step === 0 && (
          <Stack spacing={2}>
            {/* The repo is the app's linked repository — fixed context, not a
                choice. The real flow blocks + deep-links to the Repo Report if
                this repo isn't qualified yet. */}
            <Box sx={{ p: 1.5, borderRadius: 1, bgcolor: "background.neutral", border: (t) => `1px solid ${t.palette.divider}` }}>
              <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                <Typography variant="body2" color="text.secondary">Benchmarking</Typography>
                <Typography variant="subtitle2" data-testid="wizard-repo">{repoLabel}</Typography>
                <Chip size="small" color="success" variant="outlined" label="Qualified" />
              </Stack>
              <Typography variant="caption" color="text.secondary">
                Your app&apos;s linked repo. Tasks are mined from its merged PRs.
              </Typography>
            </Box>
            <Typography variant="body2" color="text.secondary">Task set: {nTasks} validated tasks</Typography>
            <Slider value={nTasks} min={20} max={200} step={1} onChange={(_e, v) => setNTasks(v as number)} valueLabelDisplay="auto" />
            <Alert severity="info" data-testid="live-mde">At {nTasks} tasks × {trials} trials, this run can detect differences ≥ {(mde * 100).toFixed(0)}pp.</Alert>
          </Stack>
        )}

        {step === 1 && (
          <Stack direction={{ xs: "column", sm: "row" }} spacing={3}>
            {configField("Config A", configA, setConfigA)}
            {configField("Config B", configB, setConfigB)}
          </Stack>
        )}

        {step === 2 && (
          <Stack spacing={3}>
            <div>
              <Typography variant="subtitle2" gutterBottom>Trials per task: {trials}</Typography>
              <Slider value={trials} min={1} max={5} step={1} marks onChange={(_e, v) => setTrials(v as number)} valueLabelDisplay="auto" />
              <Typography variant="caption" color="text.secondary">Live MDE at {nTasks}×{trials}: ≥ {(mde * 100).toFixed(0)}pp</Typography>
            </div>
            <TextField label="Budget cap (USD)" type="number" value={budget} onChange={(e) => setBudget(Number(e.target.value))} size="small" sx={{ width: 200 }} />
            <TextField select size="small" label="Sample scenario (demo)" value={scenario} onChange={(e) => setScenario(e.target.value as Verdict)} sx={{ width: 260 }} helperText="Demo stand-in until the run backend is wired.">
              <MenuItem value="clear">Clear result</MenuItem>
              <MenuItem value="directional">Directional</MenuItem>
              <MenuItem value="underpowered">Underpowered</MenuItem>
            </TextField>
          </Stack>
        )}

        {step === 3 && (
          <Stack spacing={1.5}>
            <Typography variant="body2"><strong>{configA.id}</strong> vs <strong>{configB.id}</strong> on <strong>{repoLabel}</strong></Typography>
            <Typography variant="body2">{nTasks} tasks × {trials} trials = {nTasks * 2 * trials} agent runs across 2 configs</Typography>
            <Alert severity="info">Estimated cost ${estCost.toFixed(0)} (cap ${budget}) · detectable difference ≥ {(mde * 100).toFixed(0)}pp</Alert>
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        {step > 0 && <Button onClick={() => setStep(step - 1)}>Back</Button>}
        {step < STEPS.length - 1 ? (
          <Button variant="contained" onClick={() => setStep(step + 1)} data-testid="wizard-next">Next</Button>
        ) : (
          <Button variant="contained" onClick={run} data-testid="wizard-run">Run evaluation</Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
