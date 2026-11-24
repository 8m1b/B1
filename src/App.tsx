import { useCallback, useMemo, useState } from 'react';
import { StepConfigure } from './components/StepConfigure';
import { StepResults } from './components/StepResults';
import { StepUpload } from './components/StepUpload';
import { StepVerify } from './components/StepVerify';
import { TopBar, WizardStep } from './components/TopBar';
import { runIndependentAuditPass } from './engine/audit';
import {
  filterAndRankCandidates,
  getAvailableSlotsForTimeframe,
  runCorrelationAnalysis,
} from './engine/correlation';
import { parseTimeframeFile } from './engine/parseFile';
import { exportCorrelationReportPdf } from './engine/pdfExport';
import {
  AnalysisConfig,
  AnalysisResult,
  ParseProgress,
  ResultsFilterState,
  TimeframeDataset,
  TimeframeId,
  TIMEFRAMES,
  TIMEFRAME_MAP,
} from './engine/types';

const DEFAULT_FILTERS: ResultsFilterState = {
  searchQuery: '',
  minAlignmentPct: 0,
  minSampleSize: 1,
  directionFilter: 'both',
  beforeCloseOnly: false,
  startDateUtc: '',
  endDateUtc: '',
};

function buildDefaultConfig(
  datasets: Partial<Record<TimeframeId, TimeframeDataset>>
): AnalysisConfig {
  const loaded = TIMEFRAMES.filter(
    (tf) => datasets[tf.id] && datasets[tf.id]!.candles.length > 0
  );

  if (loaded.length >= 2) {
    // Pick highest timeframe as Target (e.g. 1D) and second-highest as Search (e.g. 1H)
    const desc = loaded.slice().sort((a, b) => b.rankOrder - a.rankOrder);
    const targetTf = desc[0].id;
    const searchTf = desc[1].id;
    const supportsParent =
      TIMEFRAME_MAP[searchTf].rankOrder < TIMEFRAME_MAP[targetTf].rankOrder;
    return {
      mode: 'cross',
      targetTimeframe: targetTf,
      searchTimeframe: searchTf,
      crossStrategy: supportsParent ? 'parent_window' : 'specific_slot',
      sameStrategy: 'specific_slot',
      targetSlotKey: null,
      maxLagCandles: 12,
      includeLeadOffsets: false,
      startDateUtc: '',
      endDateUtc: '',
    };
  }

  const singleTf = loaded[0]?.id ?? '1H';
  const ds = datasets[singleTf];
  const firstSlot = ds
    ? getAvailableSlotsForTimeframe(ds.candles, singleTf, singleTf)[0]?.key ?? null
    : null;

  return {
    mode: 'same',
    targetTimeframe: singleTf,
    searchTimeframe: singleTf,
    crossStrategy: 'parent_window',
    sameStrategy: 'specific_slot',
    targetSlotKey: firstSlot,
    maxLagCandles: 12,
    includeLeadOffsets: false,
    startDateUtc: '',
    endDateUtc: '',
  };
}

export default function App() {
  const [currentStep, setCurrentStep] = useState<WizardStep>(1);
  const [datasets, setDatasets] = useState<Partial<Record<TimeframeId, TimeframeDataset>>>({});
  const [parseProgress, setParseProgress] = useState<Partial<Record<TimeframeId, ParseProgress>>>({});
  const [parseErrors, setParseErrors] = useState<Partial<Record<TimeframeId, string>>>({});
  const [selectedPreviewTf, setSelectedPreviewTf] = useState<TimeframeId | null>(null);

  const [config, setConfig] = useState<AnalysisConfig>(() => buildDefaultConfig({}));
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
  const [isRunningAnalysis, setIsRunningAnalysis] = useState(false);
  const [filters, setFilters] = useState<ResultsFilterState>(DEFAULT_FILTERS);

  const loadedTimeframes = useMemo(
    () =>
      TIMEFRAMES.map((t) => t.id).filter(
        (id) => datasets[id] && datasets[id]!.candles.length > 0
      ),
    [datasets]
  );

  const isParsingAny = Object.keys(parseProgress).length > 0;

  const maxUnlockedStep: WizardStep = useMemo(() => {
    if (loadedTimeframes.length === 0) return 1;
    if (analysisResult) return 4;
    return 3;
  }, [loadedTimeframes.length, analysisResult]);

  const handleUploadFile = useCallback(async (tf: TimeframeId, file: File) => {
    setParseErrors((prev) => {
      const copy = { ...prev };
      delete copy[tf];
      return copy;
    });
    setParseProgress((prev) => ({
      ...prev,
      [tf]: {
        timeframe: tf,
        fileName: file.name,
        percent: 0,
        rowsParsed: 0,
        stage: 'reading',
      },
    }));

    try {
      const dataset = await parseTimeframeFile(tf, file, (progress) => {
        setParseProgress((prev) => ({ ...prev, [tf]: progress }));
      });

      setDatasets((prev) => {
        const next = { ...prev, [tf]: dataset };
        return next;
      });
      setSelectedPreviewTf(tf);
      setAnalysisResult(null);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unable to parse CSV file.';
      setParseErrors((prev) => ({ ...prev, [tf]: message }));
    } finally {
      setParseProgress((prev) => {
        const copy = { ...prev };
        delete copy[tf];
        return copy;
      });
    }
  }, []);

  const handleRemoveDataset = useCallback((tf: TimeframeId) => {
    setDatasets((prev) => {
      const copy = { ...prev };
      delete copy[tf];
      return copy;
    });
    setParseErrors((prev) => {
      const copy = { ...prev };
      delete copy[tf];
      return copy;
    });
    setSelectedPreviewTf((cur) => (cur === tf ? null : cur));
    setAnalysisResult(null);
  }, []);

  const handleClearAll = useCallback(() => {
    setDatasets({});
    setParseErrors({});
    setSelectedPreviewTf(null);
    setAnalysisResult(null);
    setCurrentStep(1);
  }, []);

  const handleReRunAudit = useCallback(() => {
    setDatasets((prev) => {
      const updated: Partial<Record<TimeframeId, TimeframeDataset>> = {};
      for (const tf of TIMEFRAMES) {
        const ds = prev[tf.id];
        if (!ds) continue;
        const audited = runIndependentAuditPass(ds.candles);
        updated[tf.id] = {
          ...ds,
          status: 'verified',
          candles: audited.candles,
          audit: audited.summary,
        };
      }
      return updated;
    });
  }, []);

  const syncConfigWithDatasets = useCallback(
    (targetDatasets: Partial<Record<TimeframeId, TimeframeDataset>>) => {
      setConfig((prev) => {
        const targetExists = Boolean(targetDatasets[prev.targetTimeframe]);
        const searchExists = Boolean(targetDatasets[prev.searchTimeframe]);
        const loadedCount = TIMEFRAMES.filter((t) => Boolean(targetDatasets[t.id])).length;

        if (!targetExists || (prev.mode === 'cross' && (!searchExists || loadedCount < 2))) {
          return buildDefaultConfig(targetDatasets);
        }
        // If user added a 2nd timeframe while still on default same-TF without customizing, upgrade smoothly to cross-TF
        if (loadedCount >= 2 && prev.mode === 'same' && !analysisResult) {
          return buildDefaultConfig(targetDatasets);
        }
        return prev;
      });
    },
    [analysisResult]
  );

  const goToStep = useCallback(
    (step: WizardStep) => {
      if (step === 3) {
        syncConfigWithDatasets(datasets);
      }
      setCurrentStep(step);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    [datasets, syncConfigWithDatasets]
  );

  const executeAnalysis = useCallback(
    (activeConfig: AnalysisConfig, resetDashboardFilters = true) => {
      setIsRunningAnalysis(true);
      // Defer 1 tick so button loading state paints cleanly on large datasets
      setTimeout(() => {
        const res = runCorrelationAnalysis(datasets, activeConfig);
        setAnalysisResult(res);
        if (resetDashboardFilters) {
          setFilters({
            ...DEFAULT_FILTERS,
            startDateUtc: activeConfig.startDateUtc,
            endDateUtc: activeConfig.endDateUtc,
          });
        }
        setIsRunningAnalysis(false);
        setCurrentStep(4);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }, 20);
    },
    [datasets]
  );

  const handleDateRangeChangeOnResults = useCallback(
    (startDateUtc: string, endDateUtc: string) => {
      const nextConfig: AnalysisConfig = {
        ...config,
        startDateUtc,
        endDateUtc,
      };
      setConfig(nextConfig);
      setFilters((prev) => ({ ...prev, startDateUtc, endDateUtc }));
      const res = runCorrelationAnalysis(datasets, nextConfig);
      setAnalysisResult(res);
    },
    [config, datasets]
  );

  const handleTopBarPrimaryAction = () => {
    if (currentStep === 1) {
      goToStep(2);
    } else if (currentStep === 2) {
      goToStep(3);
    } else if (currentStep === 3) {
      executeAnalysis(config, true);
    } else if (currentStep === 4 && analysisResult) {
      const filtered = filterAndRankCandidates(analysisResult.candidates, filters);
      exportCorrelationReportPdf(analysisResult, filtered, filters, datasets);
    }
  };

  const primaryActionMeta = useMemo(() => {
    switch (currentStep) {
      case 1:
        return {
          label: 'Verify Data',
          disabled: loadedTimeframes.length === 0 || isParsingAny,
          isExport: false,
        };
      case 2:
        return {
          label: 'Configure Target',
          disabled: loadedTimeframes.length === 0,
          isExport: false,
        };
      case 3:
        return {
          label: isRunningAnalysis ? 'Analyzing...' : 'Run Analysis',
          disabled: loadedTimeframes.length === 0 || isRunningAnalysis,
          isExport: false,
        };
      case 4:
        return {
          label: 'Export PDF',
          disabled: !analysisResult,
          isExport: true,
        };
    }
  }, [currentStep, loadedTimeframes.length, isParsingAny, isRunningAnalysis, analysisResult]);

  return (
    <div className="min-h-screen bg-[#0B0F17] text-[#E2E8F0]">
      <TopBar
        currentStep={currentStep}
        maxUnlockedStep={maxUnlockedStep}
        loadedCount={loadedTimeframes.length}
        hasResults={Boolean(analysisResult)}
        onSelectStep={goToStep}
        onPrimaryAction={handleTopBarPrimaryAction}
        primaryActionLabel={primaryActionMeta.label}
        primaryActionDisabled={primaryActionMeta.disabled}
        isExportAction={primaryActionMeta.isExport}
      />

      <main className="mx-auto max-w-[1440px] px-4 py-8 sm:px-6 lg:py-10">
        {currentStep === 1 && (
          <StepUpload
            datasets={datasets}
            parseProgress={parseProgress}
            parseErrors={parseErrors}
            selectedPreviewTf={selectedPreviewTf}
            onSelectPreviewTf={setSelectedPreviewTf}
            onUploadFile={handleUploadFile}
            onRemoveDataset={handleRemoveDataset}
            onClearAll={handleClearAll}
            onProceed={() => goToStep(2)}
          />
        )}

        {currentStep === 2 && (
          <StepVerify
            datasets={datasets}
            onReRunAudit={handleReRunAudit}
            onBack={() => goToStep(1)}
            onProceed={() => goToStep(3)}
          />
        )}

        {currentStep === 3 && (
          <StepConfigure
            datasets={datasets}
            config={config}
            onChangeConfig={setConfig}
            onBack={() => goToStep(2)}
            onRunAnalysis={() => executeAnalysis(config, true)}
            isRunning={isRunningAnalysis}
          />
        )}

        {currentStep === 4 && analysisResult && (
          <StepResults
            result={analysisResult}
            datasets={datasets}
            filters={filters}
            onChangeFilters={setFilters}
            onDateRangeChange={handleDateRangeChangeOnResults}
            onBackToConfigure={() => goToStep(3)}
          />
        )}
      </main>
    </div>
  );
}
