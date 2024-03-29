/* eslint camelcase: off */
import { Express } from "express-serve-static-core";
import JSONStore from "filestore-json";
import path from "path";
import proxy from "request";
import fs from "fs/promises";
import http from "http";
import YAML from "yaml";
import https from "https";
import chalk from "chalk";
import { existsSync } from "fs";
import { Request, Response } from "express";
import httpProxy from "http-proxy";

// Cache configs
const configs = <Record<string, ConfigurationFile>>{};
const redirects = <Record<string, string>>{};
const proxies = <Record<string, httpProxy>>{};

// Get port server should run on
const PORT = process.env.PORT || 80;

// Run proxy server
export default async function server(app: Express): Promise<void> {

	// Use Stats
	const stats = JSONStore.from(path.resolve("./stats.json"), { req_counter: 0, req_per_second: 0, response_time: 0 });
	let { req_per_second, req_counter, response_time } = stats.value;

	// Redirect HTTP to HTTPS
	app.enable("trust proxy");
	app.all("*", ({ secure, hostname, url, protocol }, res, next) => {
		if (secure) return next();
		if (!protocol.startsWith("http")) return next();
		res.redirect(`https://${hostname}${url}`);
	});

	// Start HTTPS server
	const list = await fs.readdir("/etc/letsencrypt/live/", { withFileTypes: true });
	const HTTPS = https.createServer(app);

	// Install SSL erts
	list.filter(dirent => dirent.isDirectory())
		.map(async function({ name }) {
			console.info("Started SSL server on", chalk.cyan(":443"));
			HTTPS.addContext(name, {
				cert: await fs.readFile(`/etc/letsencrypt/live/${name}/cert.pem`),
				key: await fs.readFile(`/etc/letsencrypt/live/${name}/privkey.pem`)
			});
		});
	HTTPS.listen(443);

	// Finalize logging
	function finalize(timestamp: bigint, req: Request, res: Response, origin: string) {
		const rt = Math.floor(Number(process.hrtime.bigint() - timestamp) / 1000) / 1000;
		// Log response to console
		console.info(
			chalk.blueBright("OUB"),
			"->",
			chalk.cyan(`${chalk.magenta(req.protocol)}${chalk.gray("://")}${chalk.yellow(origin)}${req.url}`),
			chalk.magenta(req.method),
			chalk.greenBright(res.statusCode),
			chalk.yellowBright(`${rt}ms`)
		);
		response_time += rt;
	}

	// Proxy HTTP
	app.all("*", async function(req, res) {

		// Get timestamp
		const timestamp = process.hrtime.bigint();

		// Get requested server by origin
		const origin = (req.hostname || req.headers.host?.split(":")[0])?.toLowerCase();
		res.header("Access-Control-Allow-Origin", origin);
		res.header("Access-Control-Allow-Headers", "X-Requested-With");
		res.header("Access-Control-Allow-Headers", "Content-Type");

		// Add to stats
		req_per_second++;

		// Get origin
		if (!origin) {
			res.status(400).send("400 Bad Request! The 'host' header must be set when making requests to this server.");
			return;
		}

		// Log request as being served
		console.info(
			chalk.blueBright("INB"),
			"<-",
			chalk.cyan(`${chalk.magenta(req.protocol)}${chalk.gray("://")}${chalk.yellow(origin)}${req.url}`),
			chalk.magenta(req.method),
			chalk.redBright(req.secure ? "":"INSECURE")
		);

		// Get config
		const config = configs.hasOwnProperty(origin) ? configs[origin] : configs[origin] = <ConfigurationFile>YAML.parse(await fs.readFile(`../${origin}/config.yml`, "utf8").catch(() => "error: true"));

		// If its a redirect
		if (!config || config.error === true) {
			if (existsSync(path.resolve(`../.redirects/${origin}`))) {
				const redirect = redirects.hasOwnProperty(origin) ? redirects[origin] : redirects[origin] = await fs.readFile(path.resolve(`../.redirects/${origin}`), "utf8");
				if (redirect[0] === "*") {
					res.send(`<meta http-equiv="refresh" content="0;URL='${req.protocol}://${redirect.substring(1)}${req.path}'" />  `);
				} else {
					res.redirect(`https://${redirect}${req.path}?from=${encodeURIComponent(origin)}`);
				}
				return finalize(timestamp, req, res, origin);
			}
			res.status(400).send(`400 Bad Request! The host '${origin}' was not found on this server.`);
			return finalize(timestamp, req, res, origin);
		}

		// Initialize proxy request
		const target = `http://localhost:${config["local-port"] || config.port}`;
		const proxy = target in proxies ? proxies[target] : proxies[target] = httpProxy.createProxyServer({ target, ws: true });

		// Proxy HTTP server
		proxy.web(req, res, {});
		proxy.once("end", () => finalize(timestamp, req, res, origin));

	});

	// Start HTTP server
	const server = http.createServer(app).listen(PORT);
	console.info("Started HTTP server on", chalk.cyan(`:${PORT}`));

	server.on("upgrade", async function(req, socket, head) {
		const origin = req.headers.host!.split(":")[0].toLowerCase();
		const config = configs.hasOwnProperty(origin) ? configs[origin] : configs[origin] = <ConfigurationFile>YAML.parse(await fs.readFile(`../${origin}/config.yml`, "utf8").catch(() => "error: true"));
		const target = `http://localhost:${config["local-port"] || config.port}`;
		const proxy = target in proxies ? proxies[target] : proxies[target] = httpProxy.createProxyServer({ target, ws: true });
		proxy.ws(req, socket, head);
	});

	HTTPS.on("upgrade", async function(req, socket, head) {
		const origin = req.headers.host!.split(":")[0].toLowerCase();
		const config = configs.hasOwnProperty(origin) ? configs[origin] : configs[origin] = <ConfigurationFile>YAML.parse(await fs.readFile(`../${origin}/config.yml`, "utf8").catch(() => "error: true"));
		const target = `http://localhost:${config["local-port"] || config.port}`;
		const proxy = target in proxies ? proxies[target] : proxies[target] = httpProxy.createProxyServer({ target, ws: true });
		proxy.ws(req, socket, head);
	});

	// Every second dump stats
	setInterval(function() {
		stats.value = {
			req_per_second: req_per_second/60,
			req_counter: Math.ceil(req_counter),
			response_time: response_time/req_per_second ?? 0
		};
		req_counter += req_per_second;
		req_per_second = 0;
		response_time = 0;
	}, 60000);

}
