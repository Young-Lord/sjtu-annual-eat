/**
 * SJTU Annual Eat - CloudFlare Workers Implementation
 * 参考 Go 版本实现相同的功能
 */

// OAuth 配置
const OAUTH_CONFIG = {
	authorizationURL: 'https://jaccount.sjtu.edu.cn/oauth2/authorize',
	tokenURL: 'https://jaccount.sjtu.edu.cn/oauth2/token',
	apiURL: 'https://api.sjtu.edu.cn/v1/unicode/transactions',
	redirectURI: 'https://net.sjtu.edu.cn',
};

interface TokenResponse {
	access_token: string;
	token_type: string;
	expires_in: number;
	scope: string;
}

interface EatEntity {
	merchant: string;
	amount: number;
	orderTime: number;
	payTime: number;
}

interface EatResponse {
	entities: EatEntity[];
	errno: number;
	error?: string;
}

interface Env {
	CLIENT_ID?: string;
	CLIENT_SECRET?: string;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		// 使用环境变量覆盖默认配置
		const clientID = env.CLIENT_ID as string;
		const clientSecret = env.CLIENT_SECRET as string;

		// API 路由
		if (path.startsWith('/api/')) {
			// CORS 处理
			if (request.method === 'OPTIONS') {
				return new Response(null, {
					headers: {
						'Access-Control-Allow-Origin': '*',
						'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
						'Access-Control-Allow-Headers': 'Content-Type',
					},
				});
			}

			// OAuth 授权 URL
			if (path === '/api/auth/authorize') {
				return handleAuthorize(clientID);
			}

			// 获取 access token
			if (path === '/api/auth/token') {
				return handleGetToken(request, clientID, clientSecret);
			}

			// 获取消费数据
			if (path === '/api/data/fetch') {
				return handleFetchData(request, clientID, clientSecret);
			}

			// 生成报告
			if (path === '/api/report/generate') {
				return handleGenerateReport(request);
			}

			return new Response('Not Found', { status: 404 });
		}

		// 静态文件由 assets 配置处理
		return new Response('Not Found', { status: 404 });
	},
} satisfies ExportedHandler<Env>;

// 处理 OAuth 授权
async function handleAuthorize(clientID: string): Promise<Response> {
	const state = crypto.randomUUID();
	const params = new URLSearchParams({
		response_type: 'code',
		client_id: clientID,
		redirect_uri: OAUTH_CONFIG.redirectURI,
		scope: '',
		state: state,
	});

	const authURL = `${OAUTH_CONFIG.authorizationURL}?${params.toString()}`;

	return jsonResponse({ url: authURL, state });
}

// 获取 access token
async function handleGetToken(request: Request, clientID: string, clientSecret: string): Promise<Response> {
	try {
		const { code } = await request.json<{code: string}>();

		const formData = new URLSearchParams({
			grant_type: 'authorization_code',
			code: code,
			redirect_uri: OAUTH_CONFIG.redirectURI,
		});

		const authHeader = btoa(`${clientID}:${clientSecret}`);

		const response = await fetch(OAUTH_CONFIG.tokenURL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				Authorization: `Basic ${authHeader}`,
			},
			body: formData.toString(),
		});

		if (!response.ok) {
			const errorText = await response.text();
			return jsonResponse({ error: `获取令牌失败: ${response.status} ${errorText}` }, 400);
		}

		const token: TokenResponse = await response.json();
		return jsonResponse({ token: token.access_token });
	} catch (error) {
		return jsonResponse({ error: `请求失败: ${error}` }, 500);
	}
}

// 获取消费数据
async function handleFetchData(request: Request, clientID: string, clientSecret: string): Promise<Response> {
	try {
		const { code, startDate, endDate } = await request.json<{code: string, startDate: string, endDate: string}>();

		if (!code || !startDate || !endDate) {
			return jsonResponse({ error: '缺少必要参数' }, 400);
		}

		// 先获取 access token
		const formData = new URLSearchParams({
			grant_type: 'authorization_code',
			code: code,
			redirect_uri: OAUTH_CONFIG.redirectURI,
		});

		const authHeader = btoa(`${clientID}:${clientSecret}`);

		const tokenResponse = await fetch(OAUTH_CONFIG.tokenURL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				Authorization: `Basic ${authHeader}`,
			},
			body: formData.toString(),
		});

		if (!tokenResponse.ok) {
			const errorText = await tokenResponse.text();
			return jsonResponse({ error: `获取令牌失败: ${tokenResponse.status} ${errorText}` }, 400);
		}

		const tokenData: TokenResponse = await tokenResponse.json();
		const accessToken = tokenData.access_token;

		// 转换日期为 Unix 时间戳（本地时间）
		// 开始日期：当天的 00:00:00
		const beginDate = new Date(startDate + 'T00:00:00');
		const beginUnix = Math.floor(beginDate.getTime() / 1000);
		
		// 结束日期：当天的 23:59:59
		const endDateObj = new Date(endDate + 'T23:59:59');
		const endUnix = Math.floor(endDateObj.getTime() / 1000);

		// 获取消费数据
		const params = new URLSearchParams({
			access_token: accessToken,
			channel: '',
			start: '0',
			beginDate: beginUnix.toString(),
			endDate: endUnix.toString(),
			status: '',
		});

		const apiURL = `${OAUTH_CONFIG.apiURL}?${params.toString()}`;
		const dataResponse = await fetch(apiURL);

		if (!dataResponse.ok) {
			const errorText = await dataResponse.text();
			return jsonResponse({ error: `获取数据失败: ${dataResponse.status} ${errorText}` }, 400);
		}

		const eatData: EatResponse = await dataResponse.json();

		if (eatData.errno !== 0) {
			return jsonResponse({ error: `API 错误: errno=${eatData.errno} ${eatData.error || ''}` }, 400);
		}

		return jsonResponse({ data: eatData });
	} catch (error) {
		return jsonResponse({ error: `请求失败: ${error}` }, 500);
	}
}

// 生成报告
async function handleGenerateReport(request: Request): Promise<Response> {
	try {
		const eatData: EatResponse = await request.json();

		if (!eatData.entities || eatData.entities.length === 0) {
			return new Response('消费记录为空，无法生成报告', { status: 400 });
		}

		const reportHTML = generateReportHTML(eatData);
		return new Response(reportHTML, {
			headers: {
				'Content-Type': 'text/html; charset=utf-8',
				'Access-Control-Allow-Origin': '*',
			},
		});
	} catch (error) {
		return jsonResponse({ error: `生成报告失败: ${error}` }, 500);
	}
}

// 生成报告 HTML（参考 Go 版本的 analysis.go 和模板）
function generateReportHTML(eatData: EatResponse): string {
	// 处理数据
	const records = processEatData(eatData.entities);
	if (records.length === 0) {
		return '<html><body><h1>无有效消费记录</h1></body></html>';
	}

	// 分析数据
	const report = analyzeData(records);

	// 生成 HTML（使用 Go 版本的模板）
	return renderReportTemplate(report);
}

// 处理消费数据（参考 Go 版本的 loadEatData）
function processEatData(entities: EatEntity[]): Array<EatEntity & { normalizedMerchant: string }> {
	const filterPatterns = ['电瓶车', '游泳', '核减', '浴室', '教材科', '校医院', '充值'];
	const filterRegex = new RegExp(filterPatterns.join('|'));
	const plateRegex = /^沪[0-9A-Z]{4,7}$/i;

	const records: Array<EatEntity & { normalizedMerchant: string }> = [];

	for (const e of entities) {
		// 调整金额（取负值，保留2位小数）
		const adjAmount = Math.round(-e.amount * 100) / 100;
		if (adjAmount < 0) continue;

		// 标准化商户名称
		let normalizedMerchant = e.merchant.trim();
		if (plateRegex.test(normalizedMerchant)) {
			normalizedMerchant = '班车';
		}

		// 过滤
		if (filterRegex.test(normalizedMerchant)) continue;

		// 只保留有效时间
		if (e.payTime === 0) continue;

		records.push({
			...e,
			amount: adjAmount,
			normalizedMerchant,
		});
	}

	return records.sort((a, b) => a.payTime - b.payTime);
}

// 分析数据（参考 Go 版本的 buildReport）
interface ReportData {
	year: number;
	totalAmount: number;
	firstMealLocation: string;
	firstMealTime: string;
	firstMealAmount: number;
	maxMealLocation: string;
	maxMealTime: string;
	maxMealAmount: number;
	mostFrequentLocation: string;
	mostFrequentCount: number;
	mostFrequentAmount: number;
	mostSpentLocation: string;
	mostSpentAmount: number;
	mostSpentCount: number;
	breakfastCount: number;
	lunchCount: number;
	dinnerCount: number;
	earliestMealLocation: string;
	earliestMealTime: string;
	earliestMealAmount: number;
	peakMonth: number;
	peakMonthAmount: number;
	merchantAmount: Record<string, number>;
	monthlyAmount: Record<string, number>;
	timeDistribution: Record<string, number>;
}

function analyzeData(
	records: Array<EatEntity & { normalizedMerchant: string }>
): ReportData {
	// CST 时区偏移（秒），Go 版本使用 time.FixedZone("CST", 8*3600)
	const cstOffsetSeconds = 8 * 3600;

	let totalAmount = 0;
	// 将 Unix 时间戳（秒）转换为 CST 时间
	const firstDate = new Date((records[0].payTime + cstOffsetSeconds) * 1000);
	const year = firstDate.getUTCFullYear();

	const merchantCount: Record<string, number> = {};
	const merchantAmount: Record<string, number> = {};
	const monthAmount: Record<string, number> = {};
	const hourCount: Record<string, number> = {};

	let max = records[0];
	const dayEarliest: Record<string, typeof records[0]> = {};

	for (const r of records) {
		// 将 Unix 时间戳（秒）转换为 CST 时间
		const t = new Date((r.payTime + cstOffsetSeconds) * 1000);
		totalAmount += r.amount;

		merchantCount[r.normalizedMerchant] = (merchantCount[r.normalizedMerchant] || 0) + 1;
		merchantAmount[r.normalizedMerchant] = (merchantAmount[r.normalizedMerchant] || 0) + r.amount;

		const monthKey = String(t.getUTCMonth() + 1);
		monthAmount[monthKey] = (monthAmount[monthKey] || 0) + r.amount;

		const hourKey = String(t.getUTCHours());
		hourCount[hourKey] = (hourCount[hourKey] || 0) + 1;

		const dayKey = `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
		if (!dayEarliest[dayKey] || r.payTime < dayEarliest[dayKey].payTime) {
			dayEarliest[dayKey] = r;
		}

		if (r.amount > max.amount) {
			max = r;
		}
	}

	// 填充缺失的月份和小时
	for (let m = 1; m <= 12; m++) {
		const key = String(m);
		if (!(key in monthAmount)) {
			monthAmount[key] = 0;
		}
	}
	for (let h = 0; h < 24; h++) {
		const key = String(h);
		if (!(key in hourCount)) {
			hourCount[key] = 0;
		}
	}

	const first = records[0];
	const firstTime = new Date((first.payTime + cstOffsetSeconds) * 1000);
	const maxTime = new Date((max.payTime + cstOffsetSeconds) * 1000);

	// 最常光顾
	const mostFrequentLoc = maxCount(merchantCount);
	const mostFrequentAmount = merchantAmount[mostFrequentLoc] || 0;

	// 消费最多的地点
	const mostSpentLoc = maxAmount(merchantAmount);
	const mostSpentCount = merchantCount[mostSpentLoc] || 0;

	// 早/午/晚餐次数
	const { breakfast, lunch, dinner } = mealBuckets(records);

	// 最早的一餐
	const earliest = earliestMeal(Object.values(dayEarliest));
	const earliestTime = new Date((earliest.payTime + cstOffsetSeconds) * 1000);

	// 月度消费最高
	const peakMonth = maxAmount(monthAmount);

	return {
		year,
		totalAmount,
		firstMealLocation: first.normalizedMerchant,
		firstMealTime: formatCN(firstTime),
		firstMealAmount: first.amount,
		maxMealLocation: max.normalizedMerchant,
		maxMealTime: formatCN(maxTime),
		maxMealAmount: max.amount,
		mostFrequentLocation: mostFrequentLoc,
		mostFrequentCount: merchantCount[mostFrequentLoc] || 0,
		mostFrequentAmount,
		mostSpentLocation: mostSpentLoc,
		mostSpentAmount: merchantAmount[mostSpentLoc] || 0,
		mostSpentCount,
		breakfastCount: breakfast,
		lunchCount: lunch,
		dinnerCount: dinner,
		earliestMealLocation: earliest.normalizedMerchant,
		earliestMealTime: formatCN(earliestTime),
		earliestMealAmount: earliest.amount,
		peakMonth: parseInt(peakMonth) || 1,
		peakMonthAmount: monthAmount[peakMonth] || 0,
		merchantAmount,
		monthlyAmount: monthAmount,
		timeDistribution: hourCount,
	};
}

function maxCount(m: Record<string, number>): string {
	let maxKey = '';
	let maxValue = 0;
	for (const [k, v] of Object.entries(m)) {
		if (v > maxValue) {
			maxKey = k;
			maxValue = v;
		}
	}
	return maxKey;
}

function maxAmount(m: Record<string, number>): string {
	let maxKey = '';
	let maxValue = 0;
	for (const [k, v] of Object.entries(m)) {
		if (v > maxValue) {
			maxKey = k;
			maxValue = v;
		}
	}
	return maxKey;
}

function mealBuckets(
	records: Array<EatEntity & { normalizedMerchant: string }>
): { breakfast: number; lunch: number; dinner: number } {
	const cstOffsetSeconds = 8 * 3600;
	let breakfast = 0;
	let lunch = 0;
	let dinner = 0;

	for (const r of records) {
		const h = new Date((r.payTime + cstOffsetSeconds) * 1000).getUTCHours();
		if (h >= 6 && h < 9) {
			breakfast++;
		} else if (h >= 11 && h < 14) {
			lunch++;
		} else if (h >= 17 && h < 19) {
			dinner++;
		}
	}

	return { breakfast, lunch, dinner };
}

function earliestMeal(dayEarliest: Array<EatEntity & { normalizedMerchant: string }>): typeof dayEarliest[0] {
	const cstOffsetSeconds = 8 * 3600;
	let earliest = dayEarliest[0];
	let earliestSeconds = Infinity;

	for (const r of dayEarliest) {
		const t = new Date((r.payTime + cstOffsetSeconds) * 1000);
		const seconds = t.getUTCHours() * 3600 + t.getUTCMinutes() * 60 + t.getUTCSeconds();
		if (seconds < earliestSeconds) {
			earliest = r;
			earliestSeconds = seconds;
		}
	}

	return earliest;
}

function formatCN(date: Date): string {
	const month = date.getUTCMonth() + 1;
	const day = date.getUTCDate();
	const hour = date.getUTCHours();
	const minute = date.getUTCMinutes();
	return `${month}月${day}日${hour}时${String(minute).padStart(2, '0')}分`;
}

// 渲染报告模板（参考 Go 版本的 report.html）
function renderReportTemplate(report: ReportData): string {
	const chartData = {
		MerchantAmount: report.merchantAmount,
		MonthlyAmount: report.monthlyAmount,
		TimeDistribution: report.timeDistribution,
	};

	const reportJSON = JSON.stringify(chartData);

	return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SJTU ${report.year} 思源码年度报告</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        :root {
            --bg-color: #ffffff;
            --text-main: #2c3e50;
            --text-sub: #86868b;
            --gradient-blue: linear-gradient(135deg, #a8dadc 0%, #457b9d 100%);
            --gradient-red: linear-gradient(135deg, #f1a7a1 0%, #e5989b 100%);
            --gradient-purple: linear-gradient(135deg, #cdb4db 0%, #af97be 100%);
            --frost-bg: rgba(255, 255, 255, 0.6);
        }

        * { margin: 0; padding: 0; box-sizing: border-box; }

        html, body { height: 100%; width: 100%; overflow: hidden; }

        body {
            font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            background-color: var(--bg-color);
            color: var(--text-main);
            -webkit-font-smoothing: antialiased;
        }

        #snap-container {
            height: 100vh;
            overflow-y: scroll;
            scroll-snap-type: y mandatory;
            scroll-behavior: smooth;
        }

        .ambient-bg {
            position: fixed;
            top: 0; left: 0; width: 100vw; height: 100vh; z-index: -1;
            background: 
                radial-gradient(at 10% 10%, rgba(168, 218, 220, 0.12) 0px, transparent 50%),
                radial-gradient(at 90% 90%, rgba(205, 180, 219, 0.12) 0px, transparent 50%);
        }

        section {
            height: 100vh;
            width: 100%;
            scroll-snap-align: start;
            scroll-snap-stop: always;
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            padding: 40px 20px;
            text-align: center;
        }

        .content {
            opacity: 0;
            transform: translateY(30px);
            transition: all 1s cubic-bezier(0.25, 1, 0.5, 1);
            max-width: 850px;
            width: 100%;
        }

        section.active .content { opacity: 1; transform: translateY(0); }

        .hero-data {
            font-size: clamp(3rem, 10vw, 5rem);
            font-weight: 800;
            margin: 0.5rem 0;
            line-height: 1.1;
            display: block;
            background: var(--gradient-blue);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            letter-spacing: -2px;
        }

        .hero-red { background: var(--gradient-red); -webkit-background-clip: text; }
        .hero-purple { background: var(--gradient-purple); -webkit-background-clip: text; }

        .title-label {
            font-size: 1.2rem;
            color: var(--text-sub);
            font-weight: 400;
            margin-bottom: 0.5rem;
        }
        
        .title-label b {
            color: var(--text-main);
            font-weight: 600;
        }

        .desc-text {
            font-size: 1.1rem;
            color: var(--text-sub);
            font-weight: 400;
            line-height: 1.8;
            margin-top: 10px;
        }
        
        .desc-text b {
            color: var(--text-main);
            font-weight: 600;
        }

        .sub-quote {
            font-size: 0.95rem;
            color: var(--text-sub);
            margin-top: 2rem;
            font-weight: 300;
        }

        .dashboard-card {
            background: var(--frost-bg);
            backdrop-filter: blur(15px);
            -webkit-backdrop-filter: blur(15px);
            border: 1px solid rgba(255, 255, 255, 0.4);
            border-radius: 28px;
            padding: 24px;
            box-shadow: 0 4px 30px rgba(0,0,0,0.02);
            width: 100%;
        }

        .chart-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 20px;
            width: 100%;
            max-width: 1000px;
        }

        .chart-full-width {
            grid-column: 1 / -1;
        }

        @media (max-width: 768px) {
            .chart-grid {
                grid-template-columns: 1fr;
            }
        }

        .chart-container { height: 200px; position: relative; width: 100%; }

        .scroll-hint {
            position: absolute;
            bottom: 30px;
            animation: bounce 2.5s infinite;
            color: #d1d1d6;
            font-size: 0.75rem;
            letter-spacing: 3px;
        }

        @keyframes bounce {
            0%, 20%, 50%, 80%, 100% {transform: translateY(0);}
            40% {transform: translateY(-8px);}
            60% {transform: translateY(-4px);}
        }
    </style>
</head>
<body>

<div class="ambient-bg"></div>

<div id="snap-container">
    <section>
        <div class="content">
            <p class="title-label" style="letter-spacing: 2px;">SJTU ${report.year}</p>
            <h1 style="font-weight: 200; font-size: 2.8rem; letter-spacing: 10px; margin-top: 10px; color: var(--text-main);">思源码年度报告</h1>
            <p class="sub-quote" style="margin-top: 40px; letter-spacing: 1px;">下滑开启</p>
        </div>
    </section>

    <section>
        <div class="content">
            <p class="title-label">${report.year}年，你在交大共消费了</p>
            <h2 class="hero-data">¥${report.totalAmount.toFixed(2)}</h2>
            <p class="desc-text">每一笔开支，都是在为向往的生活投票</p>
        </div>
    </section>

    <section>
        <div class="content">
            <p class="title-label"><b>${report.firstMealLocation} </b>在</p>
            <h2 class="hero-data hero-red" style="font-size: clamp(2rem, 8vw, 4rem);">${report.firstMealTime}</h2>
            <p class="desc-text">见证了你今年第一笔消费，一共花了 <b>${report.firstMealAmount.toFixed(2)} 元</b>。<br>在交大的每一年都要有一个美好的开始。</p>
        </div>
    </section>

    <section>
        <div class="content">
            <p class="title-label"><b>${report.maxMealTime}</b>，你在<b>${report.maxMealLocation} </b>单笔最高消费了</p>
            <h2 class="hero-data hero-purple">¥${report.maxMealAmount.toFixed(2)}</h2>
            <p class="desc-text">哇，真是胃口大开的一顿！</p>
        </div>
    </section>

    <section>
        <div class="content">
            <p class="title-label">最常光顾 <b>${report.mostFrequentLocation}</b></p>
            <h2 class="hero-data">${report.mostFrequentCount} 次</h2>
            <p class="desc-text">总共花了 <b>${report.mostFrequentAmount.toFixed(2)} 元</b>。这里的美食真是让你回味无穷。</p>
        </div>
    </section>

    <section>
        <div class="content">
            <p class="title-label">你在 <b>${report.mostSpentLocation}</b> 消费最多，总计</p>
            <h2 class="hero-data hero-red">¥${report.mostSpentAmount.toFixed(2)}</h2>
            <p class="desc-text">这是 <b>${report.mostSpentCount}</b> 次消费积累而成。<br>想来这里一定有你钟爱的菜品。</p>
        </div>
    </section>

    <section>
        <div class="content">
            <p class="title-label">这一年，你一共吃了</p>
            <h2 class="hero-data hero-purple" style="font-size: clamp(1.8rem, 6vw, 3rem); letter-spacing: 0;">${report.breakfastCount} / ${report.lunchCount} / ${report.dinnerCount}</h2>
            <p class="desc-text">顿 <b>早餐 / 午餐 / 晚餐</b> <br>在交大的每一餐都要好好吃饭～</p>
        </div>
    </section>

    <section>
        <div class="content">
            <p class="title-label"><b>${report.earliestMealLocation} </b>在</p>
            <h2 class="hero-data" style="font-size: clamp(2rem, 8vw, 4rem);">${report.earliestMealTime}</h2>
            <p class="desc-text">记录下来今年最早的一次用餐，花了 <b>${report.earliestMealAmount.toFixed(2)} 元</b>。<br>令人难忘的早起！</p>
        </div>
    </section>

    <section>
        <div class="content">
            <p class="title-label">你今年消费最密集的月份是</p>
            <h2 class="hero-data hero-red">${report.peakMonth} 月</h2>
            <p class="desc-text">一共花了 <b>${report.peakMonthAmount.toFixed(2)} 元</b>。<br>这个月你一定心情不错。</p>
        </div>
    </section>

    <section style="height: auto; min-height: 100vh; padding-top: 80px;">
        <div class="content" style="max-width: 1000px;">
            <p class="title-label" style="letter-spacing: 2px; margin-bottom: 30px;">${report.year} 消费看板</p>
            
            <div class="chart-grid">
                <div class="dashboard-card">
                    <h3 style="font-size: 0.9rem; margin-bottom: 15px; font-weight: 500;">食堂消费分布</h3>
                    <div class="chart-container"><canvas id="merchantChart"></canvas></div>
                </div>
                <div class="dashboard-card">
                    <h3 style="font-size: 0.9rem; margin-bottom: 15px; font-weight: 500;">月度支出趋势</h3>
                    <div class="chart-container"><canvas id="monthlyChart"></canvas></div>
                </div>
                
                <div class="dashboard-card chart-full-width">
                    <h3 style="font-size: 0.9rem; margin-bottom: 15px; font-weight: 500;">24小时消费时间分布</h3>
                    <div class="chart-container" style="height: 180px;"><canvas id="timeChart"></canvas></div>
                </div>
            </div>

            <div style="margin-top: 50px; padding-bottom: 40px;">
                <p class="sub-quote">SJTU ${report.year} 思源码年度报告</p>
            </div>
        </div>
    </section>
</div>

<script>
    const REPORT_DATA = ${reportJSON};

    const sections = document.querySelectorAll('section');
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) entry.target.classList.add('active');
        });
    }, { threshold: 0.5 });
    sections.forEach(s => observer.observe(s));

    function initCharts() {
        Chart.defaults.font.family = 'system-ui, sans-serif';
        Chart.defaults.color = '#86868b';
        const months = Object.keys(REPORT_DATA.MonthlyAmount).sort((a,b)=>a-b);

        const legendConfig = {
            display: true,
            position: 'bottom',
            reverse: true,
            labels: {
                boxWidth: 10,
                padding: 15,
                usePointStyle: true,
                font: { size: 10 }
            }
        };

        const merchantEntries = Object.entries(REPORT_DATA.MerchantAmount || {}).sort((a, b) => b[1] - a[1]);
        const topMerchants = merchantEntries.slice(0, 5);
        const otherSum = merchantEntries.slice(5).reduce((acc, [, v]) => acc + v, 0);
        if (otherSum > 0) {
            topMerchants.push(['其他', otherSum]);
        }
        const merchantLabels = topMerchants.map(([k]) => k);
        const merchantValues = topMerchants.map(([, v]) => v);

        new Chart(document.getElementById('merchantChart'), {
            type: 'doughnut',
            data: {
                labels: merchantLabels,
                datasets: [{
                    data: merchantValues,
                    backgroundColor: ['#a8dadc', '#cdb4db', '#ffc8dd', '#bde0fe', '#f1a7a1', '#d3d3d3'],
                    borderWidth: 0,
                    hoverOffset: 10
                }]
            },
            options: { 
                responsive: true, 
                maintainAspectRatio: false, 
                plugins: { legend: legendConfig },
                cutout: '60%' 
            }
        });

        new Chart(document.getElementById('monthlyChart'), {
            type: 'bar',
            data: {
                labels: months.map(m => m + '月'),
                datasets: [{
                    label: '消费金额',
                    data: months.map(m => REPORT_DATA.MonthlyAmount[m]),
                    backgroundColor: 'rgba(168, 218, 220, 0.6)',
                    borderRadius: 4,
                    barPercentage: 0.6
                }]
            },
            options: { 
                responsive: true, 
                maintainAspectRatio: false, 
                scales: { y: { display: false }, x: { grid: { display: false } } }, 
                plugins: { legend: legendConfig }
            }
        });

        if (REPORT_DATA.TimeDistribution) {
            new Chart(document.getElementById('timeChart'), {
                type: 'line',
                data: {
                    labels: Object.keys(REPORT_DATA.TimeDistribution).map(h => h + ':00'),
                    datasets: [{
                        label: '消费频次',
                        data: Object.values(REPORT_DATA.TimeDistribution),
                        borderColor: '#cdb4db',
                        backgroundColor: 'rgba(205, 180, 219, 0.1)',
                        fill: true,
                        tension: 0.4,
                        pointRadius: 2
                    }]
                },
                options: { 
                    responsive: true, 
                    maintainAspectRatio: false, 
                    scales: { y: { display: false }, x: { grid: { display: false } } }, 
                    plugins: { legend: legendConfig }
                }
            });
        }
    }
    window.onload = initCharts;
</script>
</body>
</html>`;
}

// 辅助函数
function jsonResponse(data: any, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			'Content-Type': 'application/json',
			'Access-Control-Allow-Origin': '*',
		},
	});
}
