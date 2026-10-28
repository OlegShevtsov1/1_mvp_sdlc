require 'rails_helper'

RSpec.describe 'bin/ai-review-submit (decision 103 a)' do
  let(:script) { Rails.root.join('bin/ai-review-submit').to_s }
  let(:sha) { 'a' * 40 }
  let(:old_sha) { 'b' * 40 }
  let(:reviews_url) { 'repos/owner/repo/pulls/38/reviews' }

  # Logs every call, keeps each --input payload as payload-<n>.json, answers the review list with
  # $REVIEWS and fails the first $FAIL_POSTS review POSTs like a 422.
  let(:gh_shim) do
    <<~'SH'
      #!/usr/bin/env bash
      echo "$*" >> "$SANDBOX/gh.log"
      args=("$@")
      for (( i = 0; i < ${#args[@]}; i++ )); do
        if [[ "${args[i]}" == --input ]]; then
          n=$(( $(find "$SANDBOX" -maxdepth 1 -name 'payload-*.json' | wc -l) + 1 ))
          cp "${args[i + 1]}" "$SANDBOX/payload-${n}.json"
        fi
      done
      if [[ "$*" == *--paginate* ]]; then printf '%s' "${REVIEWS:-[]}"; exit 0; fi
      if [[ "$*" == *'-X POST'* ]]; then
        posts=$(( $(cat "$SANDBOX/posts" 2>/dev/null || echo 0) + 1 ))
        echo "${posts}" > "$SANDBOX/posts"
        if (( posts <= ${FAIL_POSTS:-0} )); then echo 'gh: Unprocessable Entity (HTTP 422)' >&2; exit 1; fi
      fi
    SH
  end

  let(:diff) do
    <<~DIFF
      diff --git a/app/x.rb b/app/x.rb
      index 1111111..2222222 100644
      --- a/app/x.rb
      +++ b/app/x.rb
      @@ -10,3 +10,4 @@ class X
       line ten
       line eleven
      +line twelve
       line thirteen
      diff --git a/app/old.rb b/app/old.rb
      deleted file mode 100644
      index 3333333..0000000
      --- a/app/old.rb
      +++ /dev/null
      @@ -1,2 +0,0 @@
      -gone
      -gone too
    DIFF
  end

  def finding(severity, path, line, title = "#{severity} at #{path}:#{line}")
    { severity: severity, path: path, line: line, title: title, body: "Why #{title}.\nHow to fix it." }
  end

  def bot_review(id, commit_id, state)
    body = "<!-- ai-review -->\n\n## AI review\n\nSummary.\n\nAI-REVIEW: P0=0 P1=0 P2=0"
    { id: id, user: { login: 'github-actions[bot]' }, commit_id: commit_id, state: state, body: body }
  end

  # A review by another workflow on the same token: the bot's login, but not this workflow's marker.
  def foreign_bot_review(id, commit_id, state, body = 'Lint report')
    { id: id, user: { login: 'github-actions[bot]' }, commit_id: commit_id, state: state, body: body }
  end

  # Runs the script over gate-like fixtures for `findings`; yields the output, the exit status, the gh
  # calls and the posted payloads.
  def submit(findings, reviews: [], env: {}, files: {})
    Dir.mktmpdir do |root|
      write_executable(File.join(root, 'gh'), gh_shim)
      dir = File.join(root, 'ai-review')
      FileUtils.mkdir_p(dir)
      p0, p1, p2 = %w[P0 P1 P2].map { |severity| findings.count { |f| f[:severity] == severity } }
      {
        'head_sha' => "#{sha}\n", 'pr.diff' => diff, 'findings.json' => findings.to_json,
        'result.json' => { p0: p0, p1: p1, p2: p2 }.to_json,
        'comment.md' => "<!-- ai-review -->\n\n## AI review\n\nSummary.\n\nAI-REVIEW: P0=#{p0} P1=#{p1} P2=#{p2}\n"
      }.merge(files).each { |name, content| content.nil? || File.write(File.join(dir, name), content) }
      full_env = {
        'PATH' => "#{root}:#{ENV.fetch('PATH')}", 'SANDBOX' => root, 'REVIEWS' => reviews.to_json,
        'GITHUB_REPOSITORY' => 'owner/repo', 'PR_NUMBER' => '38', 'GH_TOKEN' => 'test'
      }.merge(env)
      output, status = Open3.capture2e(full_env, script, 'ai-review', chdir: root)
      log = File.join(root, 'gh.log')
      calls = File.exist?(log) ? File.readlines(log, chomp: true) : []
      payloads = Dir[File.join(root, 'payload-*.json')].sort.map { |path| JSON.parse(File.read(path)) }
      yield output, status, calls, payloads
    end
  end

  it 'posts one review on the head, inline on diff lines and the rest in the body' do
    findings = [
      finding('P2', 'app/x.rb', 11), finding('P2', 'app/x.rb', 12), finding('P1', 'app/y.rb', 5),
      finding('P2', 'app/old.rb', 1), finding('P1', '', 0, 'Title convention')
    ]
    submit(findings) do |output, status, calls, payloads|
      expect(status).to be_success, output
      expect(calls.grep(/-X POST/).sole).to start_with("api -X POST #{reviews_url} --input ")
      payload = payloads.sole
      expect(payload['commit_id']).to eq(sha)
      expect(payload['comments']).to eq([
        { 'path' => 'app/x.rb', 'line' => 11, 'side' => 'RIGHT', 'body' => "**P2** P2 at app/x.rb:11\n\nWhy P2 at app/x.rb:11.\nHow to fix it." },
        { 'path' => 'app/x.rb', 'line' => 12, 'side' => 'RIGHT', 'body' => "**P2** P2 at app/x.rb:12\n\nWhy P2 at app/x.rb:12.\nHow to fix it." }
      ])
      body = payload['body']
      expect(body).to start_with('<!-- ai-review -->')
      expect(body).to end_with("\n\nAI-REVIEW: P0=0 P1=2 P2=3")
      expect(body).to include('### Findings outside the diff', '- **P1** `app/y.rb:5` P1 at app/y.rb:5',
                              '  Why P1 at app/y.rb:5.', '- **P2** `app/old.rb:1`', '- **P1** Title convention')
      expect(body).not_to include('`app/x.rb:11`')
      expect(body).not_to include('Truncated')
      expect(output).to include("AI review posted on PR #38 for #{sha}: REQUEST_CHANGES, 2 inline, 3 in the body")
    end
  end

  it 'lists each finding outside the diff once and the inline ones not at all' do
    findings = [
      finding('P2', 'app/x.rb', 11), finding('P2', 'app/x.rb', 12), finding('P1', 'app/y.rb', 5),
      finding('P2', 'app/old.rb', 1), finding('P1', '', 0, 'Title convention')
    ]
    structured = { p0: 0, p1: 2, p2: 3, comment: 'Looks fine overall.', findings: findings }.to_json
    comment = Dir.mktmpdir do |dir|
      Open3.capture2e({ 'STRUCTURED_OUTPUT' => structured }, Rails.root.join('bin/ai-review-gate').to_s, dir)
      File.read(File.join(dir, 'comment.md'))
    end
    submit(findings, files: { 'comment.md' => comment }) do |output, status, _calls, payloads|
      expect(status).to be_success, output
      body = payloads.sole['body']
      expect(body).to include('Looks fine overall.')
      [ 'P1 at app/y.rb:5', 'P2 at app/old.rb:1', 'Title convention' ].each do |title|
        expect(body.scan("Why #{title}.").size).to eq(1), title
      end
      expect(body).not_to include('app/x.rb:11', 'app/x.rb:12')
      expect(body).not_to include('Truncated')
    end
  end

  it 'caps the body and every inline comment with a truncation note' do
    findings = [ finding('P1', 'app/y.rb', 5), finding('P2', 'app/x.rb', 11) ].map { |f| f.merge(body: 'x' * 70_000) }
    submit(findings) do |output, status, _calls, payloads|
      expect(status).to be_success, output
      body = payloads.sole['body']
      expect(body.length).to be <= 60_000
      expect(body).to start_with("<!-- ai-review -->\n\n## AI review\n")
      expect(body).to end_with("\n\nAI-REVIEW: P0=0 P1=1 P2=1")
      expect(body).to include('Truncated to fit GitHub')
      comment = payloads.sole['comments'].sole['body']
      expect(comment.length).to be <= 60_000
      expect(comment).to include('Truncated to fit GitHub')
    end
  end

  # Three hunks of one file (removed lines, a gap, "\ No newline"), a new file whose path has a space (git
  # ends it with a tab) and C-quoted paths, non-ASCII and with a quote.
  let(:multi_hunk_diff) do
    <<~DIFF
      diff --git a/app/z.rb b/app/z.rb
      index 1111111..2222222 100644
      --- a/app/z.rb
      +++ b/app/z.rb
      @@ -1,3 +1,3 @@
       one
      -two
      +TWO
       three
      @@ -20,4 +20,3 @@ def z
       twenty
      -twenty-one
      -twenty-two
      +twenty-one and two
       twenty-three
      @@ -30,2 +30,3 @@ def z
       keep
      -old last
      \\ No newline at end of file
      +new last
      +added
      \\ No newline at end of file
      diff --git a/app/new file.rb b/app/new file.rb
      new file mode 100644
      index 0000000..4444444
      --- /dev/null
      +++ b/app/new file.rb\t
      @@ -0,0 +1 @@
      +only line
      diff --git "a/app/\\303\\244 b.rb" "b/app/\\303\\244 b.rb"
      new file mode 100644
      index 0000000..5555555
      --- /dev/null
      +++ "b/app/\\303\\244 b.rb"\t
      @@ -0,0 +1,2 @@
      +first
      +second
      diff --git "a/app/q\\"t.rb" "b/app/q\\"t.rb"
      new file mode 100644
      index 0000000..6666666
      --- /dev/null
      +++ "b/app/q\\"t.rb"
      @@ -0,0 +1 @@
      +quoted
    DIFF
  end

  it 'anchors to the head lines of every hunk and file, whatever the path' do
    inline = [ [ 'app/z.rb', 1 ], [ 'app/z.rb', 2 ], [ 'app/z.rb', 21 ], [ 'app/z.rb', 22 ], [ 'app/z.rb', 31 ],
               [ 'app/z.rb', 32 ], [ 'app/new file.rb', 1 ], [ 'app/ä b.rb', 2 ], [ 'app/q"t.rb', 1 ] ]
    outside = [ [ 'app/z.rb', 4 ], [ 'app/z.rb', 19 ], [ 'app/z.rb', 23 ], [ 'app/z.rb', 33 ], [ 'app/new file.rb', 2 ],
                [ 'app/ä b.rb', 3 ] ]
    findings = (inline + outside).map { |(path, line)| finding('P2', path, line) }
    submit(findings, files: { 'pr.diff' => multi_hunk_diff }) do |output, status, _calls, payloads|
      expect(status).to be_success, output
      payload = payloads.sole
      expect(payload['comments'].map { |c| [ c['path'], c['line'] ] }).to eq(inline)
      expect(payload['body']).to include(*outside.map { |(path, line)| "`#{path}:#{line}`" })
    end
  end

  {
    'a P1' => [ [ 'P1', 'app/x.rb', 11 ] ], 'a P0 only' => [ [ 'P0', 'app/x.rb', 11 ] ],
    'P2 only' => [ [ 'P2', 'app/x.rb', 11 ] ], 'no findings' => []
  }.each do |name, specs|
    event = specs.any? { |(severity)| severity != 'P2' } ? 'REQUEST_CHANGES' : 'COMMENT'
    it "submits #{event} for #{name}" do
      submit(specs.map { |args| finding(*args) }) do |output, status, _calls, payloads|
        expect(status).to be_success, output
        expect(payloads.sole['event']).to eq(event)
      end
    end
  end

  it 'leaves the outside section out when there is nothing outside the diff' do
    submit([]) do |output, status, _calls, payloads|
      expect(status).to be_success, output
      expect(payloads.sole['comments']).to eq([])
      expect(payloads.sole['body']).not_to include('### Findings')
    end
  end

  it 'posts nothing when this bot already reviewed the head' do
    submit([ finding('P2', 'app/x.rb', 11) ], reviews: [ bot_review(5, sha, 'COMMENTED') ]) do |output, status, calls, _|
      expect(status).to be_success, output
      expect(output).to include('already posted')
      expect(calls.grep(/-X (POST|PUT)/)).to be_empty
    end
  end

  it 'still posts after a review by someone else on the head or by the bot on an older head' do
    reviews = [ { id: 6, user: { login: 'OlegShevtsov1' }, commit_id: sha, state: 'COMMENTED' }, bot_review(7, old_sha, 'COMMENTED') ]
    submit([], reviews: reviews) do |output, status, calls, _|
      expect(status).to be_success, output
      expect(calls.grep(/-X POST/).size).to eq(1)
    end
  end

  { 'another body' => 'Lint report', 'no body' => nil }.each do |name, body|
    it "still posts after a github-actions[bot] review with #{name} on the head" do
      submit([], reviews: [ foreign_bot_review(5, sha, 'COMMENTED', body) ]) do |output, status, calls, _|
        expect(status).to be_success, output
        expect(calls.grep(/-X POST/).size).to eq(1)
      end
    end
  end

  it 'reads every page of the review list' do
    submit([], env: { 'REVIEWS' => "[]\n#{[ bot_review(5, sha, 'COMMENTED') ].to_json}" }) do |output, status, calls, _|
      expect(status).to be_success, output
      expect(calls.grep(/-X POST/)).to be_empty
    end
  end

  describe 'dismissing the earlier Request changes' do
    let(:reviews) do
      [
        bot_review(77, old_sha, 'CHANGES_REQUESTED'),
        { id: 78, user: { login: 'OlegShevtsov1' }, commit_id: old_sha, state: 'CHANGES_REQUESTED' },
        bot_review(79, old_sha, 'COMMENTED')
      ]
    end

    it "dismisses only this bot's Request changes once the result is clean" do
      submit([ finding('P2', 'app/x.rb', 11) ], reviews: reviews) do |output, status, calls, _|
        expect(status).to be_success, output
        expect(calls.grep(/-X PUT/)).to eq([
          "api -X PUT #{reviews_url}/77/dismissals -f message=Superseded by the AI review of #{sha} -f event=DISMISS"
        ])
      end
    end

    it "leaves another workflow's github-actions[bot] Request changes alone" do
      reviews = [ foreign_bot_review(81, old_sha, 'CHANGES_REQUESTED'), bot_review(77, old_sha, 'CHANGES_REQUESTED') ]
      submit([], reviews: reviews) do |output, status, calls, _|
        expect(status).to be_success, output
        expect(calls.grep(/-X PUT/)).to eq([
          "api -X PUT #{reviews_url}/77/dismissals -f message=Superseded by the AI review of #{sha} -f event=DISMISS"
        ])
      end
    end

    it 'retries the dismissal on a head already reviewed, its own Request changes included' do
      reviews = [ bot_review(77, old_sha, 'CHANGES_REQUESTED'), bot_review(80, sha, 'CHANGES_REQUESTED') ]
      submit([], reviews: reviews) do |output, status, calls, _|
        expect(status).to be_success, output
        expect(output).to include('already posted')
        expect(calls.grep(/-X POST/)).to be_empty
        expect(calls.grep(/-X PUT/)).to eq([
          "api -X PUT #{reviews_url}/77/dismissals -f message=Superseded by the AI review of #{sha} -f event=DISMISS",
          "api -X PUT #{reviews_url}/80/dismissals -f message=Superseded by the AI review of #{sha} -f event=DISMISS"
        ])
      end
    end

    it 'keeps it while P0/P1 remain' do
      submit([ finding('P1', 'app/x.rb', 11) ], reviews: reviews) do |output, status, calls, _|
        expect(status).to be_success, output
        expect(calls.grep(/-X PUT/)).to be_empty
      end
    end

    it 'still dismisses when the review could not be posted' do
      submit([], reviews: reviews, env: { 'FAIL_POSTS' => '2' }) do |_output, status, calls, _|
        expect(status.exitstatus).to eq(1)
        expect(calls.grep(/-X PUT/).size).to eq(1)
      end
    end
  end

  it 'retries once with every finding in the body when the inline comments are rejected' do
    findings = [ finding('P2', 'app/x.rb', 11), finding('P1', 'app/y.rb', 5) ]
    submit(findings, env: { 'FAIL_POSTS' => '1' }) do |output, status, calls, payloads|
      expect(status).to be_success, output
      expect(calls.grep(/-X POST/).size).to eq(2)
      retry_payload = payloads.last
      expect(retry_payload['comments']).to eq([])
      expect(retry_payload['event']).to eq('REQUEST_CHANGES')
      expect(retry_payload['body']).to include('### Findings', '- **P2** `app/x.rb:11`', '- **P1** `app/y.rb:5`')
      expect(retry_payload['body']).not_to include('### Findings outside the diff')
    end
  end

  it 'does not retry a rejected review that had no inline comments' do
    submit([ finding('P1', 'app/y.rb', 5) ], env: { 'FAIL_POSTS' => '1' }) do |output, status, calls, _|
      expect(status.exitstatus).to eq(1)
      expect(output).to include('::warning::AI review could not be posted on PR #38')
      expect(calls.grep(/-X POST/).size).to eq(1)
    end
  end

  it 'warns and exits 1 when the retry fails too' do
    submit([ finding('P2', 'app/x.rb', 11) ], env: { 'FAIL_POSTS' => '2' }) do |output, status, calls, _|
      expect(status.exitstatus).to eq(1)
      expect(output).to include('::warning::AI review could not be posted on PR #38')
      expect(calls.grep(/-X POST/).size).to eq(2)
    end
  end

  it 'treats the findings as data' do
    Dir.mktmpdir do |tmp|
      touched = File.join(tmp, 'touched')
      submit([ finding('P2', 'app/x.rb', 11, "$(touch #{touched}) `touch #{touched}`") ]) do |output, status, _calls, payloads|
        expect(status).to be_success, output
        expect(File).not_to exist(touched)
        expect(payloads.sole['comments'].sole['body']).to include("$(touch #{touched}) `touch #{touched}`")
      end
    end
  end

  {
    'a missing findings.json' => { 'findings.json' => nil },
    'a bad head_sha' => { 'head_sha' => "main\n" }
  }.each do |name, files|
    it "exits 2 with a usage message on #{name}, calling nothing" do
      submit([], files: files) do |output, status, calls, _|
        expect(status.exitstatus).to eq(2)
        expect(output).to include('usage')
        expect(calls).to be_empty
      end
    end
  end
end
