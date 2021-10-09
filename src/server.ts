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

// Cache configs
const configs = <Record<string, ConfigurationFile>>{};

// Get port server should run on
const PORT = process.env.PORT || 80;

// Run proxy server
export default async function server(app: Express): Promise<void> {

	// Use Stats
	const stats = JSONStore.from(path.resolve("./stats.json"), { req_counter: 0, req_per_second: 0 });
	let { req_per_second, req_counter } = stats.value;

	// Redirect HTTP to HTTPS
	app.enable("trust proxy");
	app.all("*", ({ secure, hostname, url }, res, next) => {
		if (secure) return next();
		res.redirect(`https://${hostname}${url}`);
	});

	// Start HTTPS server
	const list = await fs.readdir("/etc/letsencrypt/live/", { withFileTypes: true });
	const HTTPS = https.createServer(app);

	list.filter(dirent => dirent.isDirectory())
		.map(async function({ name }) {
			console.info("Started SSL server on", chalk.cyan(":443"));
			HTTPS.addContext(name, {
				cert: await fs.readFile(`/etc/letsencrypt/live/${name}/cert.pem`),
				key: await fs.readFile(`/etc/letsencrypt/live/${name}/privkey.pem`)
			});
		});
	HTTPS.listen(443);

	// Proxy HTTP
	app.all("*", async function(req, res) {

		// Get requested server by origin
		const origin = req.hostname || req.headers.host?.split(":")[0];
		res.header("Access-Control-Allow-Origin", origin);
		res.header("Access-Control-Allow-Headers", "X-Requested-With");
		res.header("Access-Control-Allow-Headers", "Content-Type");

		// Log request as being served
		console.info("Served:", chalk.cyan(`${chalk.magenta(req.protocol)}${chalk.gray("://")}${chalk.yellow(origin)}${req.url}`));

		// Add to stats
		req_per_second++;

		// Get origin
		if (!origin) return res.status(400).send("400 Bad Request! The 'host' header must be set when making requests to this server.");

		// Get config
		const config = configs.hasOwnProperty(origin) ? configs[origin] : configs[origin] = <ConfigurationFile>YAML.parse(await fs.readFile(`../${origin}/config.yml`, "utf8").catch(() => "error: true"));

		if (!config || config.error === true) return res.status(400).send(`400 Bad Request! The host '${origin}' was not found on this server.`);

		// Initialize proxy request
		const proxyRequest = proxy(`http://localhost:${config["local-port"] || config.port}${req.url}`);

		// Proxy HTTP server
		req.pipe(proxyRequest).pipe(res);

	});

	// Start HTTP server
	http.createServer(app).listen(PORT);
	console.info("Started HTTP server on", chalk.cyan(`:${PORT}`));

	// Every second dump stats
	setInterval(function() {
		stats.value = {
			req_per_second,
			req_counter
		};
		req_counter += req_per_second;
		req_per_second = 0;
	}, 1000);

}
