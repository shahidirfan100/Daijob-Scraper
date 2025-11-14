// Daijob scraper - CheerioCrawler implementation (robust detail parsing)
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

        const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW)
            ? Math.max(1, +RESULTS_WANTED_RAW)
            : Number.MAX_SAFE_INTEGER;
        const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW)
            ? Math.max(1, +MAX_PAGES_RAW)
            : 999;

        log.info('Starting Daijob scraper with input:', {
            keyword,
            location,
            category,
            results_wanted: RESULTS_WANTED,
            max_pages: MAX_PAGES,
            collectDetails,
            dedupe,
        });

        const toAbs = (href, base = 'https://www.daijob.com/en/') => {
            try {
                return new URL(href, base).href;
            } catch {
                return null;
            }
        };

        const cleanText = (htmlOrText) => {
            if (!htmlOrText) return null;
            const $ = cheerioLoad(`<div>${htmlOrText}</div>`);
            $('script, style, noscript, iframe').remove();
            const txt = $.root().text().replace(/\s+/g, ' ').trim();
            return txt || null;
        };

        const buildStartUrl = (kw, loc, cat) => {
            const u = new URL('https://www.daijob.com/en/jobs/search_result');
            if (kw) u.searchParams.set('keyword', String(kw).trim());
            if (loc) u.searchParams.set('location', String(loc).trim());
            if (cat) u.searchParams.set('category', String(cat).trim());
            u.searchParams.set('page', '1');
            return u.href;
        };

        const isDetailUrl = (u) => {
            try {
                const urlObj = new URL(u);
                return /\/en\/jobs\/detail\/\d+/i.test(urlObj.pathname);
            } catch {
                return /\/en\/jobs\/detail\/\d+/i.test(u);
            }
        };

        // Build initial URLs
        const initial = [];
        if (Array.isArray(startUrls) && startUrls.length) initial.push(...startUrls);
        if (startUrl) initial.push(startUrl);
        if (url) initial.push(url);
        if (!initial.length) initial.push(buildStartUrl(keyword, location, category));

        log.info(`Built ${initial.length} initial URLs`);

        const proxyConf = proxyConfiguration
            ? await Actor.createProxyConfiguration({ ...proxyConfiguration })
            : undefined;

        let saved = 0;
        const seenUrls = new Set();

        const headerGenerator = new HeaderGenerator({
            browsers: [
                { name: 'chrome', minVersion: 120 },
                { name: 'firefox', minVersion: 120 },
                { name: 'safari', minVersion: 17 },
            ],
            devices: ['desktop'],
            operatingSystems: ['windows', 'macos', 'linux'],
        });

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
                            const jobLoc = e.jobLocation;
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
                                (hiringOrg &&
                                    (hiringOrg.description || hiringOrg.disambiguatingDescription)) ||
                                null;

                            return {
                                title: e.title || e.name || null,
                                company: hiringOrg.name || null,
                                date_posted: e.datePosted || null,
                                description_html: e.description || null,
                                location,
                                salary,
                                job_type: employmentType || null,
                                industry: industry || null,
                                company_info_html: orgDescription || null,
                            };
                        }
                    }
                } catch {
                    // ignore broken JSON-LD
                }
            }
            return null;
        }

        // --- DOM helpers for labelled sections (fallback #1) ---
        function findLabelNode($, label) {
            const labelLc = label.toLowerCase();
            let found = null;
            $('body *').each((_, el) => {
                if (found) return;
                const text = $(el)
                    .clone()
                    .children()
                    .remove()
                    .end()
                    .text()
                    .trim()
                    .toLowerCase();
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
            return node.text().replace(/^Industry/i, '').trim() || null;
        }

        function extractJobTypeFromLayout($) {
            const node = findLabelNode($, 'Job Type');
            if (!node) return null;
            const link = node.find('a').first();
            if (link.length) return link.text().trim() || null;
            const next = node.nextAll().filter((_, el) => $(el).text().trim()).first();
            if (next.length) return next.text().trim() || null;
            return node.text().replace(/^Job Type/i, '').trim() || null;
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
            return node.text().replace(/^Location/i, '').trim() || null;
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
            const firstText = node
                .clone()
                .children()
                .remove()
                .end()
                .text()
                .replace(/^Company Info/i, '')
                .trim();
            if (firstText) html += `<p>${firstText}</p>`;

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
            const firstText = node
                .clone()
                .children()
                .remove()
                .end()
                .text()
                .replace(/^Job Description/i, '')
                .trim();
            if (firstText) html += `<p>${firstText}</p>`;

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

        // --- TEXT-BASED parsing from full page text (fallback #2 – VERY ROBUST) ---
        function fillFromText($, data) {
            let full = $('body').text();
            if (!full) return;
            full = full.replace(/\s+/g, ' ').trim();

            // Job Type ... Industry ...
            if (!data.job_type) {
                const m = full.match(/Job Type\s+(.+?)\s+Industry\b/i);
                if (m && m[1]) data.job_type = m[1].trim();
            }

            // Industry ... Location ...
            if (!data.industry) {
                const m = full.match(/Industry\s+(.+?)\s+Location\b/i);
                if (m && m[1]) data.industry = m[1].trim();
            }

            // Location ... Job Description ...
            if (!data.location) {
                const m = full.match(/Location\s+(.+?)\s+Job Description\b/i);
                if (m && m[1]) data.location = m[1].trim();
            }

            // Company Info ... Working Hours ...
            if (!data.company_info && !data.company_info_html) {
                const m = full.match(/Company Info\s+(.+?)\s+Working Hours\b/i);
                if (m && m[1]) {
                    const txt = m[1].trim();
                    data.company_info = txt;
                    data.company_info_html = `<p>${txt}</p>`;
                }
            }

            // Chinese Level (only when present)
            if (!data.chinese_level) {
                const m = full.match(
                    /Chinese Level\s+(.+?)\s+(Salary|Working Hours|Holidays|Japanese Level|English Level|Job Description|Company Info)\b/i,
                );
                if (m && m[1]) data.chinese_level = m[1].trim();
            }
        }

        // --- list page helpers ---
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
            let nextHref = $('a')
                .filter((_, el) => $(el).text().trim().toLowerCase() === 'next')
                .first()
                .attr('href');

            if (!nextHref && Number.isFinite(currentPage)) {
                const target = (currentPage + 1).toString();
                nextHref = $('a')
                    .filter((_, el) => $(el).text().trim() === target)
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
            maxConcurrency: 5,
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
            async requestHandler({ request, $, enqueueLinks, log: crawlerLog }) {
                const label =
                    request.userData?.label ||
                    (isDetailUrl(request.url) ? 'DETAIL' : 'LIST');
                const pageNo = request.userData?.pageNo || 1;

                // Stealth delay (no Actor.delay to avoid your previous error)
                const delay = 1000 + Math.random() * 2000;
                await new Promise((res) => setTimeout(res, delay));

                crawlerLog.info(
                    `Processing ${label} page: ${request.url}` +
                        (label === 'LIST' ? ` (page ${pageNo})` : ''),
                );

                if (label === 'LIST') {
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
                                crawlerLog.info(
                                    `Saved ${toPush.length} job URLs, total saved: ${saved}`,
                                );
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
                    } catch (error) {
                        crawlerLog.error(
                            `Error processing LIST page ${request.url}: ${error.message}`,
                        );
                    }
                    return;
                }

                // DETAIL
                if (saved >= RESULTS_WANTED) {
                    crawlerLog.info('Reached results limit, skipping detail page');
                    return;
                }

                try {
                    // Relaxed validation: any heading is enough
                    if (!$('h1, h2, h3, h4').length) {
                        crawlerLog.warn(
                            `Page ${request.url} does not look like a job detail (no headings)`,
                        );
                        return;
                    }

                    const json = extractFromJsonLd($);
                    const data = json ? { ...json } : {};

                    // Title
                    if (!data.title) {
                        data.title = $('h1, h2, h3, h4')
                            .first()
                            .text()
                            .trim() || null;
                    }

                    // Company (new layout)
                    if (!data.company) {
                        const labelNode = findLabelNode($, 'Company Name');
                        if (labelNode && labelNode.length) {
                            const next = labelNode
                                .nextAll()
                                .filter((_, el) => $(el).text().trim())
                                .first();
                            if (next.length) data.company = next.text().trim();
                        }
                    }

                    // Description
                    if (!data.description_html) {
                        const descHtml = extractDescriptionFromLayout($);
                        if (descHtml) data.description_html = descHtml;
                    }
                    data.description_text = data.description_html
                        ? cleanText(data.description_html)
                        : null;

                    // Location / salary / job_type / industry / working_hours / chinese_level / company_info
                    if (!data.location) {
                        const loc = extractLocationFromLayout($);
                        if (loc) data.location = loc;
                    }
                    if (!data.job_type) {
                        const jt = extractJobTypeFromLayout($);
                        if (jt) data.job_type = jt;
                    }
                    if (!data.industry) {
                        const ind = extractIndustryFromLayout($);
                        if (ind) data.industry = ind;
                    }
                    if (!data.working_hours) {
                        const wh = extractWorkingHoursFromLayout($);
                        if (wh) data.working_hours = wh;
                    }
                    if (!data.chinese_level) {
                        const cl = extractChineseLevelFromLayout($);
                        if (cl) data.chinese_level = cl;
                    }
                    if (!data.company_info_html && !data.company_info) {
                        const ciHtml = extractCompanyInfoFromLayout($);
                        if (ciHtml) {
                            data.company_info_html = ciHtml;
                            data.company_info = cleanText(ciHtml);
                        }
                    } else if (data.company_info_html && !data.company_info) {
                        data.company_info = cleanText(data.company_info_html);
                    }

                    // --- SUPER-ROBUST text parsing ---
                    fillFromText($, data);

                    // --- Old table layout fallback (for legacy jobs) ---
                    const tableRows = $('table tr');
                    if (tableRows.length) {
                        const findRowVal = (labelText) => {
                            const row = tableRows.filter((_, tr) => {
                                const $row = cheerioLoad(tr);
                                const first = $row('td').first().text().trim().toLowerCase();
                                return first === labelText;
                            });
                            if (!row.length) return null;
                            return row.find('td').last().html()?.trim() || null;
                        };

                        if (!data.company) {
                            const companyHtml = findRowVal('company name');
                            if (companyHtml) data.company = cleanText(companyHtml);
                        }
                        if (!data.description_html) {
                            const dHtml = findRowVal('job description');
                            if (dHtml) data.description_html = dHtml;
                            data.description_text = data.description_html
                                ? cleanText(data.description_html)
                                : data.description_text;
                        }
                        if (!data.location) {
                            const lHtml = findRowVal('location');
                            if (lHtml) data.location = cleanText(lHtml);
                        }
                        if (!data.salary) {
                            const sHtml = findRowVal('salary');
                            if (sHtml) data.salary = cleanText(sHtml);
                        }
                        if (!data.job_type) {
                            const jtHtml = findRowVal('job type');
                            if (jtHtml) data.job_type = cleanText(jtHtml);
                        }
                        if (!data.industry) {
                            const indHtml = findRowVal('industry');
                            if (indHtml) data.industry = cleanText(indHtml);
                        }
                        if (!data.working_hours) {
                            const whHtml = findRowVal('working hours');
                            if (whHtml) data.working_hours = cleanText(whHtml);
                        }
                        if (!data.chinese_level) {
                            const clHtml = findRowVal('chinese level');
                            if (clHtml) data.chinese_level = cleanText(clHtml);
                        }
                        if (!data.company_info) {
                            const ciHtml = findRowVal('company info');
                            if (ciHtml) {
                                data.company_info_html = ciHtml;
                                data.company_info = cleanText(ciHtml);
                            }
                        }
                    }

                    // Validate core fields
                    if (!data.title || !data.company) {
                        crawlerLog.warn(
                            `Incomplete job data on ${request.url}: title=${!!data.title}, company=${!!data.company}`,
                        );
                        return;
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
            },
        });

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
