// Daijob scraper - CheerioCrawler implementation
import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';
import { HeaderGenerator } from 'header-generator';

// Single-entrypoint main
await Actor.init();

async function main() {
    try {
        const input = (await Actor.getInput()) || {};
        const {
            keyword = '', location = '', category = '', results_wanted: RESULTS_WANTED_RAW = 100,
            max_pages: MAX_PAGES_RAW = 999, collectDetails = true, startUrl, startUrls, url, proxyConfiguration,
            dedupe = true,
        } = input;

        log.info('Starting Daijob scraper with input:', { keyword, location, results_wanted: RESULTS_WANTED_RAW, max_pages: MAX_PAGES_RAW, collectDetails });

        const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW) ? Math.max(1, +RESULTS_WANTED_RAW) : Number.MAX_SAFE_INTEGER;
        const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(1, +MAX_PAGES_RAW) : 999;

        const toAbs = (href, base = 'https://www.daijob.com/en/') => {
            try { return new URL(href, base).href; } catch { return null; }
        };

        const cleanText = (html) => {
            if (!html) return '';
            const $ = cheerioLoad(html);
            $('script, style, noscript, iframe').remove();
            return $.root().text().replace(/\s+/g, ' ').trim();
        };

        const buildStartUrl = (kw, loc, cat) => {
            const u = new URL('https://www.daijob.com/en/jobs/search_result');
            if (kw) u.searchParams.set('keyword', String(kw).trim());
            if (loc) u.searchParams.set('location', String(loc).trim());
            u.searchParams.set('page', '1');
            // Daijob may not have category
            return u.href;
        };

        const initial = [];
        if (Array.isArray(startUrls) && startUrls.length) initial.push(...startUrls);
        if (startUrl) initial.push(startUrl);
        if (url) initial.push(url);
        if (!initial.length) initial.push(buildStartUrl(keyword, location, category));

        log.info(`Built ${initial.length} initial URLs to scrape`);

        const proxyConf = proxyConfiguration ? await Actor.createProxyConfiguration({ ...proxyConfiguration }) : undefined;

        let saved = 0;
        const seenUrls = new Set();

        // Header generator for stealth
        const headerGenerator = new HeaderGenerator({
            browsers: [
                { name: 'chrome', minVersion: 120 },
                { name: 'firefox', minVersion: 120 },
                { name: 'safari', minVersion: 17 },
            ],
            devices: ['desktop'],
            operatingSystems: ['windows', 'macos', 'linux'],
        });

        function extractFromJsonLd($) {
            const scripts = $('script[type="application/ld+json"]');
            for (let i = 0; i < scripts.length; i++) {
                try {
                    const parsed = JSON.parse($(scripts[i]).html() || '');
                    const arr = Array.isArray(parsed) ? parsed : [parsed];
                    for (const e of arr) {
                        if (!e) continue;
                        const t = e['@type'] || e.type;
                        if (t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'))) {
                            return {
                                title: e.title || e.name || null,
                                company: e.hiringOrganization?.name || null,
                                date_posted: e.datePosted || null,
                                description_html: e.description || null,
                                location: (e.jobLocation && e.jobLocation.address && (e.jobLocation.address.addressLocality || e.jobLocation.address.addressRegion)) || null,
                            };
                        }
                    }
                } catch (e) { /* ignore parsing errors */ }
            }
            return null;
        }

        function findJobLinks($, base) {
            const links = new Set();
            $('a[href]').each((_, a) => {
                const href = $(a).attr('href');
                if (!href) return;
                if (/\/en\/jobs\/detail\/\d+/i.test(href)) {
                    const abs = toAbs(href, base);
                    if (abs) links.add(abs);
                }
            });
            return [...links];
        }

        function findNextPage($, base, currentPage) {
            const nextLink = $('a').filter((_, el) => {
                const text = $(el).text().trim();
                return text === (currentPage + 1).toString();
            }).first().attr('href');
            if (nextLink) return toAbs(nextLink, base);
            return null;
        }

        const crawler = new CheerioCrawler({
            proxyConfiguration: proxyConf,
            maxRequestRetries: 5, // Increased retries
            useSessionPool: true,
            maxConcurrency: 5, // Lower concurrency for stealth
            requestHandlerTimeoutSecs: 60,
            preNavigationHooks: [
                async (crawlingContext, requestAsBrowserOptions) => {
                    // Add stealth headers
                    const headers = headerGenerator.getHeaders();
                    requestAsBrowserOptions.headers = { ...requestAsBrowserOptions.headers, ...headers };
                    // Remove any bot-identifying headers
                    delete requestAsBrowserOptions.headers['DNT'];
                    delete requestAsBrowserOptions.headers['do-not-track'];
                    log.debug(`Requesting ${crawlingContext.request.url} with stealth headers`);
                },
            ],
            async requestHandler({ request, $, enqueueLinks, log: crawlerLog }) {
                const label = request.userData?.label || 'LIST';
                const pageNo = request.userData?.pageNo || 1;

                // Add human-like delay
                const delay = Math.random() * 2000 + 1000; // 1-3 seconds
                await new Promise(resolve => setTimeout(resolve, delay));

                crawlerLog.info(`Processing ${label} page: ${request.url} (page ${pageNo})`);

                if (label === 'LIST') {
                    try {
                        const links = findJobLinks($, request.url);
                        crawlerLog.info(`LIST ${request.url} -> found ${links.length} job links`);

                        if (collectDetails) {
                            const remaining = RESULTS_WANTED - saved;
                            const toEnqueue = links.slice(0, Math.max(0, remaining)).filter(u => !dedupe || !seenUrls.has(u));
                            if (toEnqueue.length) {
                                await enqueueLinks({ urls: toEnqueue, userData: { label: 'DETAIL' } });
                                toEnqueue.forEach(u => seenUrls.add(u));
                                crawlerLog.info(`Enqueued ${toEnqueue.length} detail pages`);
                            }
                        } else {
                            const remaining = RESULTS_WANTED - saved;
                            const toPush = links.slice(0, Math.max(0, remaining)).filter(u => !dedupe || !seenUrls.has(u));
                            if (toPush.length) {
                                await Dataset.pushData(toPush.map(u => ({ url: u, _source: 'daijob.com' })));
                                toPush.forEach(u => seenUrls.add(u));
                                saved += toPush.length;
                                crawlerLog.info(`Saved ${toPush.length} job URLs, total saved: ${saved}`);
                            }
                        }

                        if (saved < RESULTS_WANTED && pageNo < MAX_PAGES) {
                            const next = findNextPage($, request.url, pageNo);
                            if (next) {
                                await enqueueLinks({ urls: [next], userData: { label: 'LIST', pageNo: pageNo + 1 } });
                                crawlerLog.info(`Enqueued next page: ${next}`);
                            } else {
                                crawlerLog.info('No next page found');
                            }
                        }
                    } catch (error) {
                        crawlerLog.error(`Error processing LIST page ${request.url}: ${error.message}`);
                        // Continue to next request
                    }
                    return;
                }

                if (label === 'DETAIL') {
                    if (saved >= RESULTS_WANTED) {
                        crawlerLog.info('Reached results limit, skipping detail page');
                        return;
                    }
                    try {
                        // Validate if this is a job detail page
                        if (!$('h4').length || !$('table').length) {
                            crawlerLog.warn(`Page ${request.url} does not appear to be a valid job detail page (missing h4 or table)`);
                            return;
                        }

                        const json = extractFromJsonLd($);
                        const data = json || {};
                        if (!data.title) data.title = $('h4').first().text().trim() || null;
                        if (!data.company) {
                            const companyRow = $('table tr').filter((_, tr) => $(tr).find('td').first().text().trim().toLowerCase() === 'company name');
                            data.company = companyRow.length ? companyRow.find('td').last().text().trim() : null;
                        }
                        if (!data.description_html) {
                            const descRow = $('table tr').filter((_, tr) => $(tr).find('td').first().text().trim().toLowerCase() === 'job description');
                            data.description_html = descRow.length ? String(descRow.find('td').last().html()).trim() : null;
                        }
                        data.description_text = data.description_html ? cleanText(data.description_html) : null;
                        if (!data.location) {
                            const locRow = $('table tr').filter((_, tr) => $(tr).find('td').first().text().trim().toLowerCase() === 'location');
                            data.location = locRow.length ? locRow.find('td').last().text().trim() : null;
                        }
                        if (!data.salary) {
                            const salaryRow = $('table tr').filter((_, tr) => $(tr).find('td').first().text().trim().toLowerCase() === 'salary');
                            data.salary = salaryRow.length ? salaryRow.find('td').last().text().trim() : null;
                        }
                        // Extract additional fields with case-insensitive matching
                        const jobTypeRow = $('table tr').filter((_, tr) => $(tr).find('td').first().text().trim().toLowerCase() === 'job type');
                        data.job_type = jobTypeRow.length ? jobTypeRow.find('td').last().text().trim() : null;

                        const industryRow = $('table tr').filter((_, tr) => $(tr).find('td').first().text().trim().toLowerCase() === 'industry');
                        data.industry = industryRow.length ? industryRow.find('td').last().text().trim() : null;

                        const workingHoursRow = $('table tr').filter((_, tr) => $(tr).find('td').first().text().trim().toLowerCase() === 'working hours');
                        data.working_hours = workingHoursRow.length ? workingHoursRow.find('td').last().text().trim() : null;

                        const jobRequirementsRow = $('table tr').filter((_, tr) => $(tr).find('td').first().text().trim().toLowerCase() === 'job requirements');
                        data.job_requirements = jobRequirementsRow.length ? jobRequirementsRow.find('td').last().html().trim() : null;

                        const japaneseLevelRow = $('table tr').filter((_, tr) => $(tr).find('td').first().text().trim().toLowerCase() === 'japanese level');
                        data.japanese_level = japaneseLevelRow.length ? japaneseLevelRow.find('td').last().text().trim() : null;

                        const chineseLevelRow = $('table tr').filter((_, tr) => $(tr).find('td').first().text().trim().toLowerCase() === 'chinese level');
                        data.chinese_level = chineseLevelRow.length ? chineseLevelRow.find('td').last().text().trim() : null;

                        const holidaysRow = $('table tr').filter((_, tr) => $(tr).find('td').first().text().trim().toLowerCase() === 'holidays');
                        data.holidays = holidaysRow.length ? holidaysRow.find('td').last().text().trim() : null;

                        const jobContractRow = $('table tr').filter((_, tr) => $(tr).find('td').first().text().trim().toLowerCase() === 'job contract period');
                        data.job_contract_period = jobContractRow.length ? jobContractRow.find('td').last().text().trim() : null;

                        const companyInfoRow = $('table tr').filter((_, tr) => $(tr).find('td').first().text().trim().toLowerCase() === 'company info');
                        data.company_info = companyInfoRow.length ? companyInfoRow.find('td').last().html().trim() : null;

                        // Date posted not available on page
                        data.date_posted = data.date_posted || null;

                        // Validate that we have at least title and company
                        if (!data.title || !data.company) {
                            crawlerLog.warn(`Incomplete job data on ${request.url}: title=${!!data.title}, company=${!!data.company}`);
                            return;
                        }

                        const item = {
                            title: data.title || null,
                            company: data.company || null,
                            category: category || null,
                            location: data.location || null,
                            salary: data.salary || null,
                            job_type: data.job_type || null,
                            industry: data.industry || null,
                            working_hours: data.working_hours || null,
                            job_requirements: data.job_requirements ? cleanText(data.job_requirements) : null,
                            japanese_level: data.japanese_level || null,
                            chinese_level: data.chinese_level || null,
                            holidays: data.holidays || null,
                            job_contract_period: data.job_contract_period || null,
                            company_info: data.company_info ? cleanText(data.company_info) : null,
                            date_posted: data.date_posted || null,
                            description_html: data.description_html || null,
                            description_text: data.description_text || null,
                            url: request.url,
                        };

                        await Dataset.pushData(item);
                        saved++;
                        crawlerLog.info(`Saved job: ${data.title} at ${data.company}, total saved: ${saved}`);
                    } catch (err) {
                        crawlerLog.error(`DETAIL ${request.url} failed: ${err.message}`);
                        // Skip this job and continue
                    }
                }
            }
        });

        await crawler.run(initial.map(u => ({ url: u, userData: { label: 'LIST', pageNo: 1 } })));
        log.info(`Finished. Total jobs saved: ${saved}`);
    } catch (error) {
        log.error(`Actor failed: ${error.message}`, error);
        throw error;
    } finally {
        await Actor.exit();
    }
}

main().catch(err => { console.error(err); process.exit(1); });
