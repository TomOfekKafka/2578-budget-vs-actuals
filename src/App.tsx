import { useState, useEffect, useMemo } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { callMcpTool, AuthError } from './api';
import './App.css';

// ── Types ──────────────────────────────────────────────────────────────────

interface ApiRow {
  'Reporting Date': number;
  'DR_ACC_L1.5': string;
  Amount: number;
}

interface ChartDataPoint {
  category: string;
  budget: number;
  actuals: number;
  variance: number;
}

type PeriodType = 'month' | 'quarter' | 'year';

// ── Helpers ────────────────────────────────────────────────────────────────

const decodeHtml = (s: string): string => {
  const txt = document.createElement('textarea');
  txt.innerHTML = s;
  return txt.value;
};

const EXCLUDED_CATEGORIES = new Set([
  '0', 'IGNORE', 'Current Assets', 'Current Liabilities',
  'Equity', 'Long Term Liabilities', 'Non Current Assets', 'Intercompany',
]);

const formatDollar = (n: number): string => {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
};

const formatDollarFull = (n: number): string => {
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
};

const getMonthLabel = (ts: number): string =>
  new Date(ts * 1000).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

const getYear = (ts: number): number => new Date(ts * 1000).getFullYear();
const getMonth = (ts: number): number => new Date(ts * 1000).getMonth(); // 0-based
const getQuarter = (ts: number): number => Math.floor(getMonth(ts) / 3); // 0-based

// ── Mock data fallback ─────────────────────────────────────────────────────

const MOCK_CATEGORIES = ['COGS', 'G&A', 'R&D', 'S&M', 'Revenues', 'Finance expenses', 'Other', 'Tax'];

function generateMockRows(scenario: string): ApiRow[] {
  const rows: ApiRow[] = [];
  for (let year = 2022; year <= 2024; year++) {
    for (let month = 0; month < 12; month++) {
      const d = new Date(year, month + 1, 0); // end of month
      const ts = Math.floor(d.getTime() / 1000);
      for (const cat of MOCK_CATEGORIES) {
        const base = cat === 'Revenues' ? 2_000_000 : 300_000;
        const multiplier = scenario === 'Forecast' ? 1.05 : 1.0;
        rows.push({
          'Reporting Date': ts,
          'DR_ACC_L1.5': cat,
          Amount: Math.round((base + Math.random() * base * 0.3) * multiplier),
        });
      }
    }
  }
  return rows;
}

// ── Period options ─────────────────────────────────────────────────────────

interface PeriodOption {
  label: string;
  value: string;
}

function buildPeriodOptions(timestamps: number[], type: PeriodType): PeriodOption[] {
  if (type === 'month') {
    const seen = new Set<string>();
    const opts: PeriodOption[] = [];
    for (const ts of timestamps.slice().sort((a, b) => b - a)) {
      const d = new Date(ts * 1000);
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      if (!seen.has(key)) {
        seen.add(key);
        opts.push({ label: getMonthLabel(ts), value: key });
      }
    }
    return opts;
  }
  if (type === 'quarter') {
    const seen = new Set<string>();
    const opts: PeriodOption[] = [];
    for (const ts of timestamps.slice().sort((a, b) => b - a)) {
      const y = getYear(ts);
      const q = getQuarter(ts);
      const key = `${y}-Q${q + 1}`;
      if (!seen.has(key)) {
        seen.add(key);
        opts.push({ label: `Q${q + 1} ${y}`, value: key });
      }
    }
    return opts;
  }
  // year
  const seen = new Set<number>();
  const opts: PeriodOption[] = [];
  for (const ts of timestamps.slice().sort((a, b) => b - a)) {
    const y = getYear(ts);
    if (!seen.has(y)) {
      seen.add(y);
      opts.push({ label: String(y), value: String(y) });
    }
  }
  return opts;
}

function matchesPeriod(ts: number, type: PeriodType, value: string): boolean {
  if (type === 'month') {
    const d = new Date(ts * 1000);
    return value === `${d.getFullYear()}-${d.getMonth()}`;
  }
  if (type === 'quarter') {
    const y = getYear(ts);
    const q = getQuarter(ts);
    return value === `${y}-Q${q + 1}`;
  }
  return String(getYear(ts)) === value;
}

// ── App component ──────────────────────────────────────────────────────────

export default function App() {
  const [actualsData, setActualsData] = useState<ApiRow[]>([]);
  const [budgetData, setBudgetData] = useState<ApiRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [usingMock, setUsingMock] = useState(false);
  const [authError, setAuthError] = useState(false);

  const [periodType, setPeriodType] = useState<PeriodType>('year');
  const [selectedPeriod, setSelectedPeriod] = useState<string>('');

  useEffect(() => {
    async function fetchData() {
      try {
        const [actuals, budget] = await Promise.all([
          callMcpTool('aggregate_table_data', {
            table_id: '16528',
            dimensions: ['Reporting Date', 'DR_ACC_L1.5'],
            metrics: [{ field: 'Amount', agg: 'SUM' }],
            filters: [
              { name: 'Scenario', values: ['Actuals'], is_excluded: false },
              { name: 'DR_ACC_L0', values: ['P&L'], is_excluded: false },
            ],
          }),
          callMcpTool('aggregate_table_data', {
            table_id: '16528',
            dimensions: ['Reporting Date', 'DR_ACC_L1.5'],
            metrics: [{ field: 'Amount', agg: 'SUM' }],
            filters: [
              { name: 'Scenario', values: ['Forecast'], is_excluded: false },
              { name: 'DR_ACC_L0', values: ['P&L'], is_excluded: false },
            ],
          }),
        ]);
        setActualsData(actuals as ApiRow[]);
        setBudgetData(budget as ApiRow[]);
      } catch (err) {
        console.error('API error, using mock data:', err);
        if (err instanceof AuthError) {
          setAuthError(true);
        }
        setError('Could not reach API — showing demo data');
        setUsingMock(true);
        setActualsData(generateMockRows('Actuals'));
        setBudgetData(generateMockRows('Forecast'));
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, []);

  const allTimestamps = useMemo(() => {
    const ts = new Set<number>();
    for (const row of actualsData) ts.add(row['Reporting Date']);
    for (const row of budgetData) ts.add(row['Reporting Date']);
    return Array.from(ts);
  }, [actualsData, budgetData]);

  const periodOptions = useMemo(
    () => buildPeriodOptions(allTimestamps, periodType),
    [allTimestamps, periodType],
  );

  useEffect(() => {
    if (periodOptions.length > 0) {
      if (periodType === 'year') {
        const yr2024 = periodOptions.find(o => o.value === '2024');
        setSelectedPeriod(yr2024 ? yr2024.value : periodOptions[0].value);
      } else {
        setSelectedPeriod(periodOptions[0].value);
      }
    }
  }, [periodOptions, periodType]);

  const filteredActuals = useMemo(
    () => actualsData.filter(r => matchesPeriod(r['Reporting Date'], periodType, selectedPeriod)),
    [actualsData, periodType, selectedPeriod],
  );
  const filteredBudget = useMemo(
    () => budgetData.filter(r => matchesPeriod(r['Reporting Date'], periodType, selectedPeriod)),
    [budgetData, periodType, selectedPeriod],
  );

  const chartData: ChartDataPoint[] = useMemo(() => {
    const actualsMap = new Map<string, number>();
    const budgetMap = new Map<string, number>();

    for (const row of filteredActuals) {
      const cat = decodeHtml(row['DR_ACC_L1.5']);
      if (EXCLUDED_CATEGORIES.has(cat)) continue;
      actualsMap.set(cat, (actualsMap.get(cat) ?? 0) + row.Amount);
    }
    for (const row of filteredBudget) {
      const cat = decodeHtml(row['DR_ACC_L1.5']);
      if (EXCLUDED_CATEGORIES.has(cat)) continue;
      budgetMap.set(cat, (budgetMap.get(cat) ?? 0) + row.Amount);
    }

    const categories = Array.from(new Set([...actualsMap.keys(), ...budgetMap.keys()]));
    return categories
      .map(cat => {
        const actuals = actualsMap.get(cat) ?? 0;
        const budget = budgetMap.get(cat) ?? 0;
        return { category: cat, actuals, budget, variance: actuals - budget };
      })
      .sort((a, b) => Math.abs(b.actuals) - Math.abs(a.actuals));
  }, [filteredActuals, filteredBudget]);

  const totalBudget = useMemo(() => chartData.reduce((s, d) => s + d.budget, 0), [chartData]);
  const totalActuals = useMemo(() => chartData.reduce((s, d) => s + d.actuals, 0), [chartData]);
  const totalVariance = totalActuals - totalBudget;
  const variancePct = totalBudget !== 0 ? (totalVariance / Math.abs(totalBudget)) * 100 : 0;

  return (
    <div className="app">
      {authError && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            zIndex: 9999,
            background: 'linear-gradient(90deg, #dc2626, #ea580c)',
            color: '#fff',
            padding: '16px 24px',
            fontSize: '16px',
            fontWeight: 600,
            lineHeight: 1.5,
            boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
            textAlign: 'center',
          }}
        >
          ⚠️ Session expired — API credentials need to be refreshed. Please contact your administrator to re-deploy with updated credentials.
        </div>
      )}
      <header className="app-header" style={authError ? { marginTop: '60px' } : undefined}>
        <div className="header-content">
          <div>
            <h1 className="app-title">Budget vs Actuals</h1>
            <p className="app-subtitle">Financial performance comparison</p>
          </div>
          {usingMock && <div className="mock-badge">Demo Data</div>}
        </div>
      </header>

      <main className="app-main">
        {error && (
          <div className="error-banner">
            <span className="error-icon">⚠</span> {error}
          </div>
        )}

        {loading ? (
          <div className="loading-container">
            <div className="spinner" />
            <p className="loading-text">Loading financial data…</p>
          </div>
        ) : (
          <>
            {/* Period Selector */}
            <div className="controls-bar">
              <div className="controls-group">
                <label className="control-label">Period type</label>
                <div className="segmented-control">
                  {(['month', 'quarter', 'year'] as PeriodType[]).map(t => (
                    <button
                      key={t}
                      className={`segment-btn${periodType === t ? ' active' : ''}`}
                      onClick={() => setPeriodType(t)}
                    >
                      {t.charAt(0).toUpperCase() + t.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
              <div className="controls-group">
                <label className="control-label">Period</label>
                <select
                  className="period-select"
                  value={selectedPeriod}
                  onChange={e => setSelectedPeriod(e.target.value)}
                >
                  {periodOptions.map(opt => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Summary Cards */}
            <div className="summary-cards">
              <div className="summary-card">
                <div className="card-label">Total Budget</div>
                <div className="card-value">{formatDollar(totalBudget)}</div>
                <div className="card-sub">{formatDollarFull(totalBudget)}</div>
              </div>
              <div className="summary-card">
                <div className="card-label">Total Actuals</div>
                <div className="card-value">{formatDollar(totalActuals)}</div>
                <div className="card-sub">{formatDollarFull(totalActuals)}</div>
              </div>
              <div className={`summary-card variance-card ${totalVariance <= 0 ? 'under' : 'over'}`}>
                <div className="card-label">Variance ($)</div>
                <div className="card-value variance-value">{formatDollar(totalVariance)}</div>
                <div className="card-sub">{formatDollarFull(totalVariance)}</div>
              </div>
              <div className={`summary-card variance-card ${totalVariance <= 0 ? 'under' : 'over'}`}>
                <div className="card-label">Variance (%)</div>
                <div className="card-value variance-value">
                  {totalVariance > 0 ? '+' : ''}
                  {variancePct.toFixed(1)}%
                </div>
                <div className="card-sub">
                  {totalVariance <= 0 ? 'Under budget' : 'Over budget'}
                </div>
              </div>
            </div>

            {/* Bar Chart */}
            <div className="chart-card">
              <h2 className="chart-title">Budget vs Actuals by Category</h2>
              {chartData.length === 0 ? (
                <p className="no-data">No data for selected period.</p>
              ) : (
                <ResponsiveContainer width="100%" height={380}>
                  <BarChart
                    data={chartData}
                    margin={{ top: 10, right: 20, left: 20, bottom: 60 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                    <XAxis
                      dataKey="category"
                      tick={{ fontSize: 12, fill: '#6b7280' }}
                      angle={-35}
                      textAnchor="end"
                      interval={0}
                    />
                    <YAxis
                      tickFormatter={formatDollar}
                      tick={{ fontSize: 12, fill: '#6b7280' }}
                      width={70}
                    />
                    <Tooltip
                      formatter={(value: number) => formatDollarFull(value)}
                      contentStyle={{
                        background: '#fff',
                        border: '1px solid #e5e7eb',
                        borderRadius: '8px',
                        boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                      }}
                    />
                    <Legend wrapperStyle={{ paddingTop: '16px', fontSize: '13px' }} />
                    <Bar
                      dataKey="budget"
                      name="Budget"
                      fill="#f97316"
                      radius={[4, 4, 0, 0]}
                      maxBarSize={40}
                    />
                    <Bar
                      dataKey="actuals"
                      name="Actuals"
                      fill="#3b82f6"
                      radius={[4, 4, 0, 0]}
                      maxBarSize={40}
                    />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>

            {/* Variance Table */}
            <div className="table-card">
              <h2 className="chart-title">Category Breakdown</h2>
              <div className="table-wrapper">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Category</th>
                      <th>Budget</th>
                      <th>Actuals</th>
                      <th>Variance ($)</th>
                      <th>Variance (%)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {chartData.map(row => {
                      const pct =
                        row.budget !== 0 ? (row.variance / Math.abs(row.budget)) * 100 : 0;
                      const isOver = row.variance > 0;
                      return (
                        <tr key={row.category}>
                          <td className="category-cell">{row.category}</td>
                          <td className="number-cell">{formatDollarFull(row.budget)}</td>
                          <td className="number-cell">{formatDollarFull(row.actuals)}</td>
                          <td className={`number-cell variance-cell ${isOver ? 'over' : 'under'}`}>
                            {isOver ? '+' : ''}
                            {formatDollarFull(row.variance)}
                          </td>
                          <td className={`number-cell variance-cell ${isOver ? 'over' : 'under'}`}>
                            {isOver ? '+' : ''}
                            {pct.toFixed(1)}%
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
