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
			// 获取消费数据（访问 tokenURL 和 apiURL 在后端进行）
			if (path === '/api/data/fetch') {
				return handleFetchData(request, clientID, clientSecret);
			}

			return new Response('Not Found', { status: 404 });
		}

		// 静态文件由 assets 配置处理
		return new Response('Not Found', { status: 404 });
	},
} satisfies ExportedHandler<Env>;

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
