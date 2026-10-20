# Evaluates the part of the GitHub Actions expression language that workflow job conditions use
# (property paths, string literals, ==, !=, !, &&, ||, parentheses, startsWith, contains, fromJSON),
# so a spec can run a job-level if against an event payload instead of matching its text.
# Like GitHub, string comparison ignores case and '', 0, false and null are falsy.
class GithubExpression
  TOKEN = /'[^']*'|&&|\|\||[!=]=|[!(),]|[\w.\[\]-]+/

  def self.evaluate(expression, context)
    new(expression, context).evaluate
  end

  def initialize(expression, context)
    @tokens = expression.scan(TOKEN)
    @context = context
  end

  def evaluate
    value = disjunction
    raise ArgumentError, "unexpected #{@tokens.first.inspect}" unless @tokens.empty?

    truthy?(value)
  end

  private

  def disjunction
    left = conjunction
    while accept('||')
      right = conjunction
      left = right unless truthy?(left)
    end
    left
  end

  def conjunction
    left = comparison
    while accept('&&')
      right = comparison
      left = right if truthy?(left)
    end
    left
  end

  def comparison
    left = unary
    while (operator = accept('==', '!='))
      left = same?(left, unary) == (operator == '==')
    end
    left
  end

  def unary
    accept('!') ? !truthy?(unary) : primary
  end

  def primary
    token = @tokens.shift or raise ArgumentError, 'unexpected end of expression'
    case token
    when '(' then disjunction.tap { expect(')') }
    when /\A'(.*)'\z/m then Regexp.last_match(1)
    when 'startsWith', 'contains', 'fromJSON' then call(token)
    else @context.dig(*token.split('.'))
    end
  end

  def call(function)
    expect('(')
    first = disjunction
    return JSON.parse(first).tap { expect(')') } if function == 'fromJSON'

    expect(',')
    second = disjunction
    expect(')')
    return first.any? { |item| same?(item, second) } if first.is_a?(Array)

    function == 'startsWith' ? first.to_s.downcase.start_with?(second.to_s.downcase) : first.to_s.downcase.include?(second.to_s.downcase)
  end

  def same?(left, right)
    left.is_a?(String) && right.is_a?(String) ? left.casecmp?(right) : left == right
  end

  def truthy?(value)
    !(value.nil? || value == false || value == '' || value == 0)
  end

  def accept(*candidates)
    @tokens.shift if candidates.include?(@tokens.first)
  end

  def expect(token)
    accept(token) or raise ArgumentError, "expected #{token.inspect}, got #{@tokens.first.inspect}"
  end
end
