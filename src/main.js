// Daijob scraper - CheerioCrawler implementation (fixed & extended)
// Fetches job list pages OR single job detail pages and extracts rich fields.

import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';
import { HeaderGenerator } from 'header-generator';

// Top-level init for ESM actors
await Actor.init();

async function main() {
    try {
        const input = (await Actor.getInput()) || {};
        const {
            keyword = '',
            location = '',
            category = '',
            results_wanted: RESULTS_WANTED_RAW = 100,
            max_pages: MAX_PAGES_RAW = 999,
            collectDetails = true,
            startUrl,
            startUrls,
            url,
            proxyConfiguration,
            dedupe = true,
        } = input;

        const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW) ? +RESULTS_WANTED_RAW : 100;
        const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? +MAX_PAGES_RAW : 999;

        log.info('Starting Daijob scraper with input:', {
            keyword,
            location,
            category,
            results_wanted: RESULTS_WANTED,
            max_pages: MAX_PAGES,
            collectDetails,
            dedupe,
        });

        const proxyConf = await Actor.createProxyConfiguration(proxyConfiguration || {});

        const headerGenerator = new HeaderGenerator({
            browsers: [
                { name: 'chrome', minVersion: 120 },
                { name: 'firefox', minVersion: 120 },
                { name: 'safari', minVersion: 17 },
            ],
            devices: ['desktop'],
            operatingSystems: ['windows', 'macos', 'linux'],
        });

        let saved = 0;
        const seenUrls = new Set();

        function isDetailUrl(u) {
            try {
                const urlObj = new URL(u);
                return /\/en\/jobs\/detail\/\d+/i.test(urlObj.pathname);
            } catch {
                return /\/en\/jobs\/detail\/\d+/i.test(u);
            }
        }

        function toAbs(href, base) {
            try {
                return new URL(href, base).href;
            } catch {
                return null;
            }
        }

        // --- JSON-LD extraction (JobPosting) -----------------
        function extractFromJsonLd($) {
            const scripts = $('script[type="application/ld+json"]');
            for (let i = 0; i < scripts.length; i++) {
                try {
                    const raw = $(scripts[i]).html() || '';
                    if (!raw.trim()) continue;
                    const parsed = JSON.parse(raw);
                    const arr = Array.isArray(parsed) ? parsed : [parsed];

                    for (const e of arr) {
                        if (!e) continue;
                        const t = e['@type'] || e.type;
                        if (t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'))) {
                            const hiringOrg = e.hiringOrganization || {};
                            const jobLoc = e.jobLocation || e.jobLocationType;
                            let location = null;

                            if (jobLoc && jobLoc.address) {
                                const addr = jobLoc.address;
                                const parts = [
                                    addr.addressCountry,
                                    addr.addressRegion,
                                    addr.addressLocality,
                                    addr.streetAddress,
                                ]
                                    .filter(Boolean)
                                    .map((s) => String(s).trim());
                                if (parts.length) location = parts.join(' > ');
                            }

                            // salary may be in baseSalary or salary fields
                            let salary = null;
                            if (e.baseSalary) {
                                const bs = e.baseSalary;
                                const cur = bs.currency || bs.salaryCurrency || '';
                                const val = bs.value || {};
                                const amountMin = val.minValue ?? val.value ?? null;
                                const amountMax = val.maxValue ?? null;
                                const unit = val.unitText || bs.unitText || '';
                                const parts = [];
                                if (cur) parts.push(String(cur));
                                if (amountMin != null && amountMax != null) {
                                    parts.push(`${amountMin} - ${amountMax}`);
                                } else if (amountMin != null) {
                                    parts.push(String(amountMin));
                                }
                                if (unit) parts.push(unit);
                                if (parts.length) salary = parts.join(' ');
                            } else if (e.salary) {
                                salary = String(e.salary);
                            }

                            const employmentType = e.employmentType || null;
                            const industry = e.industry || null;
                            const orgDescription =
                                (hiringOrg && (hiringOrg.description || hiringOrg.disambiguatingDescription)) ||
                                null;

                            return {
                                title: e.title || e.name || null,
                                company: hiringOrg.name || null,
                                date_posted: e.datePosted || null,
                                description_html: e.description || null,
                                location: location,
                                salary: salary,
                                job_type: employmentType || null,
                                industry: industry || null,
                                company_info_html: orgDescription || null,
                            };
                        }
                    }
                } catch {
                    // ignore JSON-LD parse errors and keep going
                }
            }
            return null;
        }

        function cleanText(htmlOrText) {
            if (!htmlOrText) return null;
            const $ = cheerioLoad(`<div>${htmlOrText}</div>`);
            const text = $.root().text();
            return text.replace(/\s+/g, ' ').trim() || null;
        }

        // --- New-layout helpers for labelled sections (Industry, Location, etc.) ----
        function findLabelNode($, label) {
            const labelLc = label.toLowerCase();
            let found = null;

            $('body *').each((_, el) => {
                if (found) return;
                const text = $(el).clone().children().remove().end().text().trim().toLowerCase();
                if (!text) return;
                if (text === labelLc || text.startsWith(labelLc)) {
                    found = $(el);
                }
            });
            return found;
        }

        function extractIndustryFromLayout($) {
            const node = findLabelNode($, 'Industry');
            if (!node) return null;
            const link = node.find('a').first();
            if (link.length) return link.text().trim() || null;
            const text = node.text().replace(/^Industry/i, '').trim();
            return text || null;
        }

        function extractJobTypeFromLayout($) {
            const node = findLabelNode($, 'Job Type');
            if (!node) return null;
            const link = node.find('a').first();
            if (link.length) return link.text().trim() || null;
            const next = node.nextAll().filter((_, el) => $(el).text().trim()).first();
            if (next.length) return next.text().trim() || null;
            const text = node.text().replace(/^Job Type/i, '').trim();
            return text || null;
        }

        function extractLocationFromLayout($) {
            const node = findLabelNode($, 'Location');
            if (!node) return null;
            const links = node.find('a');
            if (links.length) {
                const parts = links
                    .map((_, a) => $(a).text().trim())
                    .get()
                    .filter(Boolean);
                if (parts.length) return parts.join(' > ');
            }
            const text = node.text().replace(/^Location/i, '').trim();
            return text || null;
        }

        function extractSalaryFromLayout($) {
            const node = findLabelNode($, 'Salary');
            if (!node) return null;
            // Include the label node and perhaps its following sibling which has additional details
            let text = node.text().replace(/^Salary/i, '').trim();
            const next = node.next();
            if (next && next.length) {
                const nextText = next.text().trim();
                if (nextText) text += (text ? ' ' : '') + nextText;
            }
            text = text.replace(/\s+/g, ' ').trim();
            return text || null;
        }

        function extractWorkingHoursFromLayout($) {
            const node = findLabelNode($, 'Working Hours');
            if (!node) return null;
            let text = node.text().replace(/^Working Hours/i, '').trim();
            if (!text) {
                const next = node.nextAll().filter((_, el) => $(el).text().trim()).first();
                if (next.length) text = next.text().trim();
            }
            return text || null;
        }

        function extractChineseLevelFromLayout($) {
            const node = findLabelNode($, 'Chinese Level');
            if (!node) return null;
            let text = node.text().replace(/.*Chinese Level/i, '').trim();
            if (!text) {
                const next = node.nextAll().filter((_, el) => $(el).text().trim()).first();
                if (next.length) text = next.text().trim();
            }
            return text || null;
        }

        function extractCompanyInfoFromLayout($) {
            const node = findLabelNode($, 'Company Info');
            if (!node) return null;

            // Take text from the Company Info label node onwards until we hit the next "big" label.
            const stopMarkers = [
                'working hours',
                'job requirements',
                'requirements',
                'english level',
                'japanese level',
                'salary',
                'holidays',
            ];

            let html = '';
            let cur = node;

            // Include text *after* the "Company Info" label itself
            const firstText = node
                .clone()
                .children()
                .remove()
                .end()
                .text()
                .replace(/^Company Info/i, '')
                .trim();
            if (firstText) {
                html += `<p>${firstText}</p>`;
            }

            while (true) {
                cur = cur.next();
                if (!cur || !cur.length) break;
                const txtLc = cur.text().trim().toLowerCase();
                if (!txtLc) continue;
                if (stopMarkers.some((m) => txtLc.startsWith(m))) break;
                html += $.html(cur);
            }

            return html || null;
        }

        function extractDescriptionFromLayout($) {
            const node = findLabelNode($, 'Job Description');
            if (!node) return null;

            const stopMarkers = [
                'company info',
                'working hours',
                'job requirements',
                'requirements',
                'english level',
                'japanese level',
                'salary',
                'holidays',
            ];

            let html = '';

            // Text right after "Job Description" on same line
            const firstText = node
                .clone()
                .children()
                .remove()
                .end()
                .text()
                .replace(/^Job Description/i, '')
                .trim();
            if (firstText) {
                html += `<p>${firstText}</p>`;
            }

            let cur = node;
            while (true) {
                cur = cur.next();
                if (!cur || !cur.length) break;
                const txtLc = cur.text().trim().toLowerCase();
                if (!txtLc) continue;
                if (stopMarkers.some((m) => txtLc.startsWith(m))) break;
                html += $.html(cur);
            }

            return html || null;
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
            // Try a "Next" link first
            let nextHref = $('a').filter((_, el) => $(el).text().trim().toLowerCase() === 'next').first().attr('href');
            if (!nextHref && Number.isFinite(currentPage)) {
                // Try numbered pagination: look for the link with text == currentPage + 1
                const targetText = (currentPage + 1).toString();
                nextHref = $('a')
                    .filter((_, el) => $(el).text().trim() === targetText)
                    .first()
                    .attr('href');
            }
            if (!nextHref) return null;
            return toAbs(nextHref, base);
        }

        const crawler = new CheerioCrawler({
            proxyConfiguration: proxyConf,
            maxRequestRetries: 5,
            useSessionPool: true,
            maxConcurrency: 5, // keep it low for stealth
            requestHandlerTimeoutSecs: 60,
            preNavigationHooks: [
                async (crawlingContext, requestAsBrowserOptions) => {
                    const headers = headerGenerator.getHeaders();
                    requestAsBrowserOptions.headers = {
                        ...(requestAsBrowserOptions.headers || {}),
                        ...headers,
                    };
                    delete requestAsBrowserOptions.headers.DNT;
                    delete requestAsBrowserOptions.headers['do-not-track'];
                    log.debug(`Requesting ${crawlingContext.request.url} with stealth headers`);
                },
            ],
            requestHandler: async (ctx) => {
                const { request, $, enqueueLinks } = ctx;
                const { label, pageNo = 1 } = request.userData;
                const crawlerLog = log.child({ url: request.url, label });

                // Gentle delay for stealth
                await Actor.delay(1000 + Math.random() * 2000);

                const currentLabel =
                    label ||
                    (isDetailUrl(request.url) ? 'DETAIL' : 'LIST');

                if (currentLabel === 'LIST') {
                    try {
                        const links = findJobLinks($, request.url);
                        crawlerLog.info(`LIST ${request.url} -> found ${links.length} job links`);

                        if (collectDetails) {
                            const remaining = RESULTS_WANTED - saved;
                            const toEnqueue = links
                                .slice(0, Math.max(0, remaining))
                                .filter((u) => !dedupe || !seenUrls.has(u));
                            if (toEnqueue.length) {
                                await enqueueLinks({
                                    urls: toEnqueue,
                                    userData: { label: 'DETAIL' },
                                });
                                toEnqueue.forEach((u) => seenUrls.add(u));
                                crawlerLog.info(`Enqueued ${toEnqueue.length} detail pages`);
                            }
                        } else {
                            const remaining = RESULTS_WANTED - saved;
                            const toPush = links
                                .slice(0, Math.max(0, remaining))
                                .filter((u) => !dedupe || !seenUrls.has(u));
                            if (toPush.length) {
                                await Dataset.pushData(
                                    toPush.map((u) => ({ url: u, _source: 'daijob.com' })),
                                );
                                toPush.forEach((u) => seenUrls.add(u));
                                saved += toPush.length;
                                crawlerLog.info(`Saved ${toPush.length} job URLs, total saved: ${saved}`);
                            }
                        }

                        if (saved < RESULTS_WANTED && pageNo < MAX_PAGES) {
                            const next = findNextPage($, request.url, pageNo);
                            if (next) {
                                await enqueueLinks({
                                    urls: [next],
                                    userData: { label: 'LIST', pageNo: pageNo + 1 },
                                });
                                crawlerLog.info(`Enqueued next page: ${next}`);
                            } else {
                                crawlerLog.info('No next page found');
                            }
                        }
                    } catch (err) {
                        crawlerLog.error(`LIST ${request.url} failed: ${err.message}`);
                    }
                } else if (currentLabel === 'DETAIL') {
                    try {
                        // RELAXED PAGE VALIDATION: we no longer require a <table> (Daijob changed layout)
                        if (!$('h1, h2, h3, h4').length) {
                            crawlerLog.warn(
                                `Page ${request.url} does not appear to be a valid job detail page (no headings found)`,
                            );
                            return;
                        }

                        // 1) Try JSON-LD first
                        const json = extractFromJsonLd($);
                        const data = json ? { ...json } : {};

                        // --- title ---
                        if (!data.title) {
                            data.title = $('h1, h2, h3, h4')
                                .first()
                                .text()
                                .trim() || null;
                        }

                        // --- company name ---
                        if (!data.company) {
                            // New layout: "Company Name" label then heading
                            const labelNode = findLabelNode($, 'Company Name');
                            if (labelNode && labelNode.length) {
                                const next = labelNode
                                    .nextAll()
                                    .filter((_, el) => $(el).text().trim())
                                    .first();
                                if (next.length) {
                                    data.company = next.text().trim();
                                }
                            }
                        }

                        // --- description_html & text ---
                        if (!data.description_html) {
                            // New layout: "Job Description" followed by free text and bullet points
                            const descHtml = extractDescriptionFromLayout($);
                            if (descHtml) {
                                data.description_html = descHtml;
                            }
                        }
                        data.description_text = data.description_html
                            ? cleanText(data.description_html)
                            : null;

                        // --- location ---
                        if (!data.location) {
                            const loc = extractLocationFromLayout($);
                            if (loc) data.location = loc;
                        }

                        // --- salary ---
                        if (!data.salary) {
                            const salary = extractSalaryFromLayout($);
                            if (salary) data.salary = salary;
                        }

                        // --- job_type ---
                        if (!data.job_type) {
                            const jt = extractJobTypeFromLayout($);
                            if (jt) data.job_type = jt;
                        }

                        // --- industry ---
                        if (!data.industry) {
                            const ind = extractIndustryFromLayout($);
                            if (ind) data.industry = ind;
                        }

                        // --- working hours ---
                        if (!data.working_hours) {
                            const wh = extractWorkingHoursFromLayout($);
                            if (wh) data.working_hours = wh;
                        }

                        // --- chinese level ---
                        if (!data.chinese_level) {
                            const cl = extractChineseLevelFromLayout($);
                            if (cl) data.chinese_level = cl;
                        }

                        // --- company info ---
                        if (!data.company_info_html && !data.company_info) {
                            const ciHtml = extractCompanyInfoFromLayout($);
                            if (ciHtml) {
                                data.company_info_html = ciHtml;
                                data.company_info = cleanText(ciHtml);
                            }
                        } else if (data.company_info_html && !data.company_info) {
                            data.company_info = cleanText(data.company_info_html);
                        }

                        const item = {
                            title: data.title || null,
                            company: data.company || null,
                            location: data.location || null,
                            salary: data.salary || null,
                            job_type: data.job_type || null,
                            industry: data.industry || null,
                            working_hours: data.working_hours || null,
                            chinese_level: data.chinese_level || null,
                            company_info: data.company_info || null,
                            date_posted: data.date_posted || null,
                            description_html: data.description_html || null,
                            description_text: data.description_text || null,
                            url: request.url,
                        };

                        await Dataset.pushData(item);
                        saved++;
                        crawlerLog.info(
                            `Saved job: ${item.title || 'N/A'} at ${
                                item.company || 'N/A'
                            }, total saved: ${saved}`,
                        );
                    } catch (err) {
                        crawlerLog.error(`DETAIL ${request.url} failed: ${err.message}`);
                    }
                }
            },
        });

        // --- Build initial URLs (keep backwards-compatible) -------------
        const initial = [];

        const addUrl = (u) => {
            if (!u) return;
            if (Array.isArray(u)) {
                u.forEach(addUrl);
            } else if (typeof u === 'string' && u.trim()) {
                initial.push(u.trim());
            }
        };

        addUrl(startUrl);
        addUrl(startUrls);
        addUrl(url);

        // If still empty, fall back to generic search results
        if (!initial.length) {
            const params = new URLSearchParams();
            if (keyword) params.set('keywords', keyword);
            // location/category are trickier; safest is to let user provide startUrls,
            // but we include them in the query string anyway:
            if (location) params.set('location', location);
            if (category) params.set('category', category);

            const searchUrl = params.toString()
                ? `https://www.daijob.com/en/jobs/search_result?${params.toString()}`
                : 'https://www.daijob.com/en/jobs/search_result';

            initial.push(searchUrl);
        }

        const initialRequests = initial.map((u) => ({
            url: u,
            userData: isDetailUrl(u)
                ? { label: 'DETAIL' }
                : { label: 'LIST', pageNo: 1 },
        }));

        await crawler.run(initialRequests);
        log.info(`Finished. Total jobs saved: ${saved}`);
    } catch (error) {
        log.error(`Actor failed: ${error.message}`, error);
        throw error;
    } finally {
        await Actor.exit();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
