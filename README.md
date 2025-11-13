# Daijob Scraper

[![Apify Actor](https://img.shields.io/badge/Apify-Actor-blue)](https://apify.com)
[![Daijob Jobs](https://img.shields.io/badge/Jobs-Daijob.com-orange)](https://www.daijob.com/en/)
[![Japan Jobs](https://img.shields.io/badge/Location-Japan-green)](https://www.daijob.com/en/)

A powerful web scraper for extracting job listings from Daijob.com, Japan's leading job site for bilingual professionals and foreigners seeking work in Japan. This actor efficiently collects job data including titles, companies, locations, salaries, and detailed descriptions.

## 🚀 Key Features

- **Comprehensive Job Data**: Extracts detailed job information including titles, companies, locations, salaries, and full job descriptions
- **Flexible Search Options**: Search by keywords, locations, or specific URLs
- **Pagination Support**: Automatically handles multiple result pages
- **Detail Extraction**: Optional deep scraping for complete job descriptions
- **Deduplication**: Built-in duplicate removal for clean datasets
- **Proxy Integration**: Supports Apify Proxy for reliable scraping
- **Structured Output**: Consistent JSON schema for easy data processing

## 📋 What You Can Scrape

- Job titles and positions
- Company names and information
- Job locations (cities in Japan)
- Salary ranges
- Job descriptions (HTML and plain text)
- Posting dates
- Direct job URLs

## 🔧 Input Parameters

| Parameter | Type | Description | Default |
|-----------|------|-------------|---------|
| `keyword` | string | Job search keywords (e.g., "software engineer", "marketing manager") | - |
| `location` | string | Location filter (e.g., "Tokyo", "Osaka", "Yokohama") | - |
| `startUrl` | string | Specific Daijob search URL to start scraping from | - |
| `startUrls` | array | Multiple Daijob URLs to scrape | - |
| `collectDetails` | boolean | Whether to visit job detail pages for full descriptions | `true` |
| `results_wanted` | integer | Maximum number of jobs to collect | `100` |
| `max_pages` | integer | Maximum number of search pages to visit | `20` |
| `dedupe` | boolean | Remove duplicate job URLs | `true` |
| `proxyConfiguration` | object | Proxy settings for scraping | Apify Proxy |

## 📤 Output Schema

Each scraped job is saved as a JSON object with the following structure:

```json
{
  "title": "Software Engineer",
  "company": "Tech Company Inc.",
  "location": "Tokyo",
  "salary": "JPY 4000K - JPY 6000K",
  "job_type": "IT/Engineering - Software Development",
  "industry": "Information Technology",
  "working_hours": "9:00 AM - 6:00 PM",
  "job_requirements": "Requirements text...",
  "japanese_level": "Business Level",
  "chinese_level": "Business Conversation Level",
  "holidays": "Full 2-day weekend, Paid annual leave",
  "job_contract_period": "Full-time employee",
  "company_info": "Company information...",
  "date_posted": "2025-11-13",
  "description_html": "<p>Detailed job description...</p>",
  "description_text": "Plain text version of the job description",
  "url": "https://www.daijob.com/en/jobs/detail/12345"
}
```

## 🎯 Usage Examples

### Basic Keyword Search
```json
{
  "keyword": "software engineer",
  "location": "Tokyo",
  "results_wanted": 50
}
```

### Custom URL Scraping
```json
{
  "startUrl": "https://www.daijob.com/en/jobs/search/?keyword=marketing&location=Osaka",
  "collectDetails": true,
  "results_wanted": 25
}
```

### Multiple URLs
```json
{
  "startUrls": [
    "https://www.daijob.com/en/jobs/search/?keyword=engineer",
    "https://www.daijob.com/en/jobs/search/?keyword=designer&location=Tokyo"
  ],
  "max_pages": 5
}
```

## ⚙️ Configuration

### Proxy Settings
For best results, use Apify Proxy with residential IPs:
```json
{
  "proxyConfiguration": {
    "useApifyProxy": true,
    "apifyProxyGroups": ["RESIDENTIAL"]
  }
}
```

### Performance Tuning
- Set `results_wanted` to limit the number of jobs collected
- Use `max_pages` to control pagination depth
- Enable `dedupe` to avoid duplicate entries

## 📊 Dataset Views

The actor provides multiple dataset views for different use cases:

- **Overview**: Table view with key job information
- **Detailed**: Full job descriptions and metadata
- **Company Analysis**: Grouped by company
- **Location Analysis**: Jobs by location

## 💰 Cost Optimization

- **Free Tier**: Up to 100 jobs per run
- **Paid Usage**: $0.50 per 1000 jobs
- **Proxy Costs**: Additional charges for proxy usage
- **Tips**: Use specific keywords and locations to reduce result volume

## 🔍 SEO Keywords

Daijob scraper, job scraper Japan, Daijob jobs, Japan job listings, bilingual jobs Japan, foreign jobs Tokyo, Osaka jobs, Japanese job market, international jobs Japan, Daijob data extraction, job scraping tool, employment data Japan

## 📈 Use Cases

- **Job Market Analysis**: Track job trends in Japan
- **Recruitment Research**: Find candidates for specific roles
- **Company Intelligence**: Monitor hiring patterns
- **Career Planning**: Research job opportunities
- **Market Research**: Analyze salary ranges and requirements

## ⚠️ Important Notes

- Respect Daijob's terms of service
- Use reasonable request limits to avoid rate limiting
- The actor handles pagination automatically
- Results are deduplicated by default
- Some jobs may require Japanese language skills

## 🆘 Troubleshooting

### Common Issues
- **No results found**: Check keyword spelling and location filters
- **Rate limiting**: Reduce `results_wanted` or add delays
- **Incomplete data**: Ensure `collectDetails` is enabled for full descriptions

### Best Practices
- Start with small result sets for testing
- Use specific keywords for better results
- Monitor your usage to optimize costs
- Review output data for completeness

## 📞 Support

For issues or feature requests, please check the Apify community forums or contact support through the Apify platform.

---

*This actor is designed for research and analysis purposes. Always comply with website terms of service and applicable laws.*