import fs2, { promises as fs } from "fs";
import YAML from "yaml";
import http from "http";
import chalk from "chalk";
import https from "https";
import proxy from "request";
import express from "express";
import compression from "compression";

// Cache configs
const configs = {};

// Initialize stats
let stats;

// Add methods to console
console.info = function(){ console.log(chalk.blue("[INFO]"), ...arguments); };
console.error = function(){ console.log(chalk.red("[ERROR]"), ...arguments); };
console.warn = function(){ console.log(chalk.yellow("[WARN]"), ...arguments); };
console.success = function(){ console.log(chalk.green("[SUCCESS]"), ...arguments); };

// Log errors to console instead of killing the application
process.on("uncaughtException", err => console.error(err));

// Initialize request counter
let reqCounter = 0;
let reqPerSecond = 0;
let sampleTimes = [];

// Start server
(async function server(app) {

	// Attempt to get previous stats
	try {
		stats = JSON.parse(await fs.readFile("./stats.db", "utf8"));
	} catch (e) {
		stats = {};
	}

	// Redirect HTTP to HTTPS
	app.all("*", ({ secure, hostname, url }, res, next) => {
		if (secure) return next();
		res.redirect(`https://${hostname}${url}`);
	});

	// Proxy HTTP
	app.all("*", async (request, response) => {

		// Get requested server by origin
		const origin = request.headers["host"];
		response.header("Access-Control-Allow-Origin", origin);
		response.header("Access-Control-Allow-Headers", "X-Requested-With");
		response.header("Access-Control-Allow-Headers", "Content-Type");

		// Get config
		let config;
		if(configs.hasOwnProperty(origin)) config = configs[origin];
		else {
			try {
				config = YAML.parse(await fs.readFile(`../${origin}/config.yml`, "utf8"));
			} catch(e) {
				response.status(501);
				response.write(`Requested server "${origin}" not found.`);
			}
		}

		// Add to request counters
		reqCounter++;
		reqPerSecond++;

		// Log request
		console.info("Served:", chalk.cyan(origin + request.url));

		// Initialize proxy request
		const proxyRequest = proxy(`http://localhost:${config["local-port"] || config["port"]}${request.url}`);

		// Proxy HTTP server
		request.pipe(proxyRequest).pipe(response);

	});

	// Set interval to log requests
	setInterval(async function() {

		stats.req_per_second = reqPerSecond;
		stats.req_counter = reqCounter;

		sampleTimes = sampleTimes.arr.slice(0, 100);
		stats.avg_response_time = sampleTimes.reduce((sum, el) => sum + el, 0);

		await fs.writeFile("./stats.db", JSON.stringify(stats, null, 4), "utf8");
		reqPerSecond = 0;

	}, 1000);

	// Use gzip
	app.use(compression());

	// Start HTTP server
	http.createServer(app).listen(80);

	// Start HTTPS server
	(async function() {
		const list = await fs.readdir("/etc/letsencrypt/live/", { withFileTypes: true });
		const HTTPS = https.createServer(app);

		list
			.filter(dirent => dirent.isDirectory())
			.map(function({ name }) {
				console.info(chalk.yellow("[SSL]"), "Added SSL context for", chalk.cyan(name));
				HTTPS.addContext(name, {
					cert: fs2.readFileSync(`/etc/letsencrypt/live/${name}/cert.pem`),
					key: fs2.readFileSync(`/etc/letsencrypt/live/${name}/privkey.pem`)
				});
			});
		HTTPS.listen(443);

	}());

}(express()));
