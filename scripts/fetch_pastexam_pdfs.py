#!/usr/bin/env python3
"""過去問PDFの一括ダウンロード補助スクリプト（中小企業診断協会サイト用）。

ClaudeCodeのクラウド実行環境からは対象サイトへの直接アクセスがネットワークポリシーで
ブロックされているため、このスクリプトは「ユーザー自身のPC」で実行することを想定している
（このリポジトリのセッション内では実行できない）。標準ライブラリのみで動くので、
pipでの追加インストールは不要。

指定したページのリンクを解析し、.pdf で終わるリンクをすべて一覧化してダウンロードする。
特定のURLパターンを決め打ちしていないので、サイトの実際のページ構造が事前にわからなくても
動作する。--follow で指定したキーワードを含むリンクだけ、さらに1階層以上辿ることもできる
（例：年度一覧ページから各年度のページへ）。

使い方:
  # まずは辿らず、そのページに直接あるPDFリンクだけ一覧・ダウンロード
  python3 scripts/fetch_pastexam_pdfs.py https://www.jf-cmca.jp/contents/010_c_/shikenmondai.html

  # 「令和」を含むリンクをさらに1階層辿ってPDFを探す（年度別ページがある場合など）
  python3 scripts/fetch_pastexam_pdfs.py <URL> --follow 令和 --depth 2

  # 保存先フォルダを指定
  python3 scripts/fetch_pastexam_pdfs.py <URL> --out ./pastexam_pdfs

注意:
  - 同一ドメイン配下のリンクしか辿らない（無関係な外部サイトには出ていかない）
  - リクエスト間に既定0.5秒の間隔を空ける（サイトに負荷をかけすぎないため）
  - ダウンロードしたPDFの著作権は協会に帰属する。個人の学習目的以外での利用・再配布はしないこと
"""
import argparse
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser

USER_AGENT = "shindanshi-app-pastexam-fetcher/1.0 (personal study use)"


class LinkExtractor(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = []  # list of (href, text)
        self._current_href = None
        self._current_text = []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            href = dict(attrs).get("href")
            if href:
                self._current_href = href
                self._current_text = []

    def handle_data(self, data):
        if self._current_href is not None:
            self._current_text.append(data)

    def handle_endtag(self, tag):
        if tag == "a" and self._current_href is not None:
            text = "".join(self._current_text).strip()
            self.links.append((self._current_href, text))
            self._current_href = None
            self._current_text = []


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        charset = resp.headers.get_content_charset() or "utf-8"
        return resp.read().decode(charset, errors="replace")


def extract_links(html, base_url):
    parser = LinkExtractor()
    parser.feed(html)
    return [(urllib.parse.urljoin(base_url, href), text) for href, text in parser.links]


def same_domain(url, root_url):
    return urllib.parse.urlparse(url).netloc == urllib.parse.urlparse(root_url).netloc


def sanitize_filename(name):
    name = re.sub(r'[\\/:*?"<>|]', "_", name)
    name = re.sub(r"\s+", "_", name).strip("_")
    return name[:80] if name else "link"


def crawl(start_url, follow_keyword, max_depth, out_dir, delay):
    visited_pages = set()
    pdf_links = {}  # url -> link text
    queue = [(start_url, 0)]

    while queue:
        url, depth = queue.pop(0)
        if url in visited_pages:
            continue
        visited_pages.add(url)
        print(f"[取得中] depth={depth}: {url}")
        try:
            html = fetch(url)
        except (urllib.error.URLError, TimeoutError) as e:
            print(f"  失敗: {e}", file=sys.stderr)
            continue
        time.sleep(delay)

        for link_url, link_text in extract_links(html, url):
            if not same_domain(link_url, start_url):
                continue
            if link_url.lower().split("?")[0].endswith(".pdf"):
                pdf_links.setdefault(link_url, link_text or os.path.basename(urllib.parse.urlparse(link_url).path))
            elif depth < max_depth and follow_keyword and follow_keyword in link_text and link_url not in visited_pages:
                queue.append((link_url, depth + 1))

    print(f"\n{len(pdf_links)} 件のPDFリンクを検出しました。")
    if not pdf_links:
        print("見つかりませんでした。--follow でページをもう1階層辿る必要があるかもしれません。")
        return

    os.makedirs(out_dir, exist_ok=True)
    for url, text in pdf_links.items():
        orig_name = os.path.basename(urllib.parse.urlparse(url).path)
        fname = (sanitize_filename(text) + "__" + orig_name) if text else orig_name
        dest = os.path.join(out_dir, fname)
        if os.path.exists(dest):
            print(f"  スキップ（既存）: {fname}")
            continue
        print(f"  ダウンロード: {text!r} -> {fname}")
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=60) as resp, open(dest, "wb") as f:
                f.write(resp.read())
        except (urllib.error.URLError, TimeoutError) as e:
            print(f"    失敗: {e}", file=sys.stderr)
        time.sleep(delay)

    print(f"\n完了。保存先: {os.path.abspath(out_dir)}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("url", help="起点となるページのURL")
    ap.add_argument("--follow", default=None, help="このキーワードを含むリンクテキストのページをさらに辿る（例: 令和）")
    ap.add_argument("--depth", type=int, default=1, help="--follow で辿る最大階層数（既定: 1＝起点ページのみ）")
    ap.add_argument("--out", default="./pastexam_pdfs", help="PDFの保存先フォルダ（既定: ./pastexam_pdfs）")
    ap.add_argument("--delay", type=float, default=0.5, help="リクエスト間隔（秒、既定: 0.5）")
    args = ap.parse_args()
    crawl(args.url, args.follow, args.depth, args.out, args.delay)


if __name__ == "__main__":
    main()
